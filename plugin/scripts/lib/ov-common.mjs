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

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

export function readConfig() {
  let url = process.env.OPENVIKING_URL || "";
  let apiKey = process.env.OPENVIKING_API_KEY || "";
  let conf = {};
  const confPath = process.env.OPENVIKING_CLI_CONFIG_FILE || join(homedir(), ".openviking", "ovcli.conf");
  try { conf = JSON.parse(readFileSync(confPath, "utf8")) || {}; } catch { /* absent */ }
  url = url || conf.url || "";
  apiKey = apiKey || conf.api_key || "";

  // plugin knobs: shared `plugin` scalars, then the `plugin.agent_plugins`
  // harness section over them; env vars win over both.
  const plugin = conf.plugin && typeof conf.plugin === "object" ? conf.plugin : {};
  const harness = plugin.agent_plugins && typeof plugin.agent_plugins === "object" ? plugin.agent_plugins : {};
  const pick = (key, def) => (harness[key] !== undefined ? harness[key] : plugin[key] !== undefined ? plugin[key] : def);
  const skillCatalog = envFlag("OPENVIKING_SKILL_CATALOG", pick("skillCatalog", true));
  const rawBudget = process.env.OPENVIKING_SKILL_CATALOG_TOKEN_BUDGET !== undefined && process.env.OPENVIKING_SKILL_CATALOG_TOKEN_BUDGET !== ""
    ? Number(process.env.OPENVIKING_SKILL_CATALOG_TOKEN_BUDGET)
    : Number(pick("skillCatalogTokenBudget", 1200));
  const skillCatalogTokenBudget = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : 1200;

  const bypassSession = envFlag("OPENVIKING_BYPASS_SESSION", pick("bypassSession", false));
  const bypassEnv = (process.env.OPENVIKING_BYPASS_SESSION_PATTERNS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const bypassConf = harness.bypassSessionPatterns ?? harness.bypassPatterns
    ?? plugin.bypassSessionPatterns ?? plugin.bypassPatterns;
  const bypassSessionPatterns = bypassEnv.length
    ? bypassEnv
    : (Array.isArray(bypassConf) ? bypassConf : []);

  return {
    url: (url || "").replace(/\/+$/, ""),
    apiKey,
    skillCatalog,
    skillCatalogTokenBudget,
    bypassSession,
    bypassSessionPatterns,
  };
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

/**
 * Glob -> RegExp for the bypass matcher, same semantics as the shared
 * memory-plugin-shared matcher: `*` stops at a path separator, `**` crosses
 * them, everything else is a literal.
 */
function globToRe(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

/**
 * Whether the session cwd falls under a bypass rule: the whole session stays
 * out of OpenViking (no recall, no profile injection, no capture). A scratch
 * directory matched here never pollutes long-term memory.
 */
export function isBypassed(cfg, { cwd = "" } = {}) {
  if (cfg?.bypassSession) return true;
  const patterns = cfg?.bypassSessionPatterns || [];
  if (!patterns.length) return false;
  // Windows hands hooks `C:\work\scratch` while directory patterns are written
  // with forward slashes — match both spellings.
  const slashCwd = typeof cwd === "string" && cwd.includes("\\") ? cwd.replace(/\\/g, "/") : "";
  const haystacks = [cwd, slashCwd].filter(Boolean);
  for (const pat of patterns) {
    let re;
    try { re = globToRe(pat); } catch { continue; }
    if (haystacks.some((h) => re.test(h))) return true;
  }
  return false;
}