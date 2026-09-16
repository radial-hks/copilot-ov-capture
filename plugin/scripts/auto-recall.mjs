#!/usr/bin/env node

/**
 * Auto-recall hook for VS Code Copilot (UserPromptSubmit).
 * Ported from the official Claude Code plugin's auto-recall.mjs concept:
 * searches OpenViking with the workspace peer scope and injects the result
 * into the agent's context via the hook's stdout JSON.
 *
 * VS Code hook output contract (Hooks reference):
 *   UserPromptSubmit supports hookSpecificOutput.additionalContext — extra
 *   context attached to the prompt. Exit 0 + JSON on stdout.
 *
 * Design mirrors the official plugin:
 *   - health check first; offline -> silent no-op (never block the prompt)
 *   - workspace peer (actor scope) so recall is project-relevant
 *   - server-assembled context (mode="context", peer_scope="actor")
 *   - short/empty prompts skipped; failures degrade to approve-and-continue
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ---- config (same resolution chain as uploader) ----
function readConfig() {
  let url = process.env.OPENVIKING_URL || "";
  let apiKey = process.env.OPENVIKING_API_KEY || "";
  if (!url || !apiKey) {
    const confPath = process.env.OPENVIKING_CLI_CONFIG_FILE || join(homedir(), ".openviking", "ovcli.conf");
    try {
      const conf = JSON.parse(readFileSync(confPath, "utf8"));
      url = url || conf.url || "";
      apiKey = apiKey || conf.api_key || "";
    } catch { /* error below */ }
  }
  return { url: (url || "").replace(/\/+$/, ""), apiKey };
}

// ---- workspace peer (same derivation as uploader) ----
function safePeerId(raw) {
  const cleaned = String(raw || "").trim().replace(/[^a-zA-Z0-9_.@-]+/g, "-").replace(/-{2,}/g, "-");
  return cleaned.replace(/^[.-]+|[.-]+$/g, "") || "";
}
function normalizeGitRemote(url) {
  const raw = String(url || "").trim();
  if (!raw || /^[A-Za-z]:[\\/]/.test(raw)) return "";
  let u = raw.replace(/^[a-z]+@/i, "");
  if (u.startsWith("ssh://")) u = u.slice("ssh://".length).replace(/^git@/, "");
  u = u.replace(/^[a-z+.\-]+:\/\//i, "");
  if (!u.includes("://") && /^[^\/]+:[^\/]/.test(u)) u = u.replace(":", "/");
  u = u.replace(/^[^@/]+@/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return u.toLowerCase();
}
function readWorkspaceConfigPeer(root) {
  for (const name of ["config.local.json", "config.json"]) {
    try {
      const conf = JSON.parse(readFileSync(join(root, ".openviking", name), "utf8"));
      const pid = conf?.peer?.id;
      if (typeof pid === "string" && pid.trim()) return safePeerId(pid);
    } catch { /* next */ }
  }
  return "";
}
function findWorkspaceRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git")) ||
        existsSync(join(dir, ".openviking", "config.json")) ||
        existsSync(join(dir, ".openviking", "config.local.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function workspacePeerId(cwd) {
  if (!cwd) return "";
  const root = findWorkspaceRoot(cwd);
  if (!root) return "";
  const configured = readWorkspaceConfigPeer(root);
  if (configured) return configured;
  if (!existsSync(join(root, ".git"))) return "";
  let origin = "";
  try {
    const raw = readFileSync(join(root, ".git", "config"), "utf8");
    const m = raw.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
    origin = m ? normalizeGitRemote(m[1]) : "";
  } catch { /* no config */ }
  const raw = origin || root;
  let cleaned = safePeerId(raw);
  if (!cleaned) return "";
  if (cleaned.length > 100) {
    cleaned = cleaned.slice(0, 87).replace(/[-.]+$/, "") + "-" + createHash("sha256").update(raw).digest("hex").slice(0, 12);
  }
  return cleaned;
}

// ---- main ----
async function main() {
  // read stdin JSON (VS Code writes UTF-8; raw bytes -> UTF-8 decode)
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  let ev = {};
  try { ev = JSON.parse(raw); } catch { process.exit(0); }

  const cwd = ev.cwd || process.cwd();
  const prompt = String(ev.prompt || "").trim();
  const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };

  // gates: never block the prompt, never recall for trivial prompts
  if (!prompt || prompt.length < 8) out({});

  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) out({}); // not configured yet — silent

  const peer = workspacePeerId(cwd);
  const headers = {
    "Authorization": `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    ...(peer ? { "X-OpenViking-Actor-Peer": peer } : {}),
  };

  try {
    const t0 = Date.now();
    const body = {
      query: prompt.slice(0, 2000),
      mode: "context",
      ...(peer ? { peer_scope: "actor" } : {}),
    };
    const res = await fetch(cfg.url + "/api/v1/search/search", {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) out({}); // server error — degrade silently
    const json = await res.json();
    const entries = (json?.result?.entries) || [];
    // Relevance floor: server context mode mixes low-score broad hits; keep
    // only entries within 0.8x of the top score so the injected block stays
    // tight (official plugin uses score_threshold the same way).
    const top = entries.length ? entries[0].score || 0 : 0;
    const floor = Math.max(0.35, top * 0.8);
    const strong = entries.filter(e => (e.score || 0) >= floor);
    if (!strong.length) out({});

    // Render a compact context block from the strong entries.
    const lines = [];
    const seen = new Set();
    for (const e of strong) {
      if (seen.has(e.uri)) continue;
      seen.add(e.uri);
      const text = String(e.text || "").trim();
      const label = e.uri || "";
      if (text) {
        lines.push(`- ${text}`);
      } else if (label) {
        lines.push(`- related: ${label}`);
      }
      if (lines.length >= 8) break;
    }
    if (!lines.length) out({});
    const block = `<openviking-context source="auto-recall" peer="${peer || "user-level"}">\n`
      + `Relevant memories from the team's OpenViking knowledge base (use as prior\n`
      + `context; verify against current code where relevant):\n`
      + lines.join("\n")
      + `\n</openviking-context>`;
    out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } });
  } catch { out({}); } // any failure — never block the prompt
}

main();
