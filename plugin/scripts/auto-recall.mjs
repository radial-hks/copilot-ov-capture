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
 *
 * v0.4: forwards session_id (import__copilot__<id>, the same OV session the
 * capture pipeline writes to) so the server-side context face runs query
 * expansion and the cross-turn dedup ledger — official integration
 * convention #1 (session_id must ride along with every recall call).
 */

import { readConfig, workspacePeerId } from "./lib/ov-common.mjs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

const OV_SESSION_PREFIX = "import__copilot__";


/**
 * Recall logic, exported for in-process testing. Returns the hook output
 * object ({} on every skip/failure path — the prompt is never blocked).
 */
export async function runRecall(ev = {}) {
  const cwd = ev.cwd || process.cwd();
  const prompt = String(ev.prompt || "").trim();

  // gates: never recall for trivial prompts
  if (!prompt || prompt.length < 8) return {};

  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) return {}; // not configured yet — silent

  const peer = workspacePeerId(cwd);
  const headers = {
    "Authorization": `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    ...(peer ? { "X-OpenViking-Actor-Peer": peer } : {}),
  };

  try {
    const body = {
      // Recall queries stay short: the intent lives in the prompt's opening,
      // and long queries push the server's expansion/rerank stage past the
      // hook budget (measured on the team server: >15s for long queries with
      // default expansion, <2s without).
      query: prompt.slice(0, 400),
      mode: "context",
      // session_id carries official convention #1 (cross-turn dedup ledger +
      // session-aware recall) — independent of query_expansion, so the slow
      // expansion stage can stay off while keeping the dedup benefit.
      query_expansion: "off",
      rewrite: "off",
      ...(ev.session_id ? { session_id: OV_SESSION_PREFIX + ev.session_id } : {}),
      ...(peer ? { peer_scope: "actor" } : {}),
    };
    const res = await fetch(cfg.url + "/api/v1/search/search", {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return {}; // server error — degrade silently
    const json = await res.json();
    const entries = (json?.result?.entries) || [];
    // Relevance floor: server context mode mixes low-score broad hits; keep
    // only entries within 0.8x of the top score so the injected block stays
    // tight (official plugin uses score_threshold the same way).
    const top = entries.length ? entries[0].score || 0 : 0;
    const floor = Math.max(0.35, top * 0.8);
    const strong = entries.filter(e => (e.score || 0) >= floor);
    if (!strong.length) return {};

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
    if (!lines.length) return {};
    const block = `<openviking-context source="auto-recall" peer="${peer || "user-level"}">\n`
      + `Relevant memories from the team's OpenViking knowledge base (use as prior\n`
      + `context; verify against current code where relevant):\n`
      + lines.join("\n")
      + `\n</openviking-context>`;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } };
  } catch { return {}; } // any failure — never block the prompt
}
async function main() {
  // read stdin JSON (VS Code writes UTF-8; raw bytes -> UTF-8 decode)
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let ev = {};
  // process.exit() right after an async process.stdout.write() crashes node on
  // Windows (libuv uv_async assert, 0xC0000409). Returning lets the loop drain
  // so the write flushes before node exits 0.
  try { ev = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return; }
  const out = await runRecall(ev);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main().catch(() => {}); // a hook must never crash or block the prompt
}
