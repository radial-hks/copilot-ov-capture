/**
 * Shared config + workspace-peer helpers for the plugin's hook scripts
 * (auto-recall / session-start). Extracted verbatim from auto-recall.mjs so
 * new hooks stop growing a third copy of the same chain.
 *
 * Config resolution matches the uploader: OPENVIKING_URL / OPENVIKING_API_KEY
 * env -> ~/.openviking/ovcli.conf (url + api_key).
 *
 * Workspace peer derivation matches the official client design:
 * .openviking/config.json peer.id > normalized git origin > repo root;
 * non-workspace directories send no peer (user-level space).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export function readConfig() {
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

export function safePeerId(raw) {
  const cleaned = String(raw || "").trim().replace(/[^a-zA-Z0-9_.@-]+/g, "-").replace(/-{2,}/g, "-");
  return cleaned.replace(/^[.-]+|[.-]+$/g, "") || "";
}

export function normalizeGitRemote(url) {
  const raw = String(url || "").trim();
  if (!raw || /^[A-Za-z]:[\\/]/.test(raw)) return "";
  let u = raw.replace(/^[a-z]+@/i, "");
  if (u.startsWith("ssh://")) u = u.slice("ssh://".length).replace(/^git@/, "");
  u = u.replace(/^[a-z+.\-]+:\/\//i, "");
  if (!u.includes("://") && /^[^\/]+:[^\/]/.test(u)) u = u.replace(":", "/");
  u = u.replace(/^[^@/]+@/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return u.toLowerCase();
}

export function readWorkspaceConfigPeer(root) {
  for (const name of ["config.local.json", "config.json"]) {
    try {
      const conf = JSON.parse(readFileSync(join(root, ".openviking", name), "utf8"));
      const pid = conf?.peer?.id;
      if (typeof pid === "string" && pid.trim()) return safePeerId(pid);
    } catch { /* next */ }
  }
  return "";
}

export function findWorkspaceRoot(startDir) {
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

export function workspacePeerId(cwd) {
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

/**
 * Minimal fetchJSON compatible with the vendored profile-inject.mjs:
 * resolves to { ok, status, result } and never throws.
 */
export function makeFetchJSON(cfg, { peerId = "", defaultTimeoutMs = 10000 } = {}) {
  return async function fetchJSON(path, init = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || defaultTimeoutMs;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
      ...(peerId ? { "X-OpenViking-Actor-Peer": peerId } : {}),
      ...(init.headers || {}),
    };
    try {
      const res = await fetch(cfg.url + path, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.status === "error") {
        return { ok: false, status: res.status, result: null, error: body?.error || { message: `HTTP ${res.status}` } };
      }
      return { ok: true, status: res.status, result: body?.result ?? body ?? {} };
    } catch (error) {
      return { ok: false, status: 0, result: null, error: { message: error?.message || String(error) } };
    }
  };
}