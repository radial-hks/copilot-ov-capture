/**
 * Single source of truth for the Copilot plugin's configuration knobs.
 *
 * One declaration per knob (type, default, env var, older spellings, range),
 * resolved once here and reused by the hook face (ov-common.mjs) and the
 * uploader, so the two can no longer drift. Resolution layers, highest first:
 *
 *   OPENVIKING_* env  ->  ovcli.conf plugin.agent_plugins  ->  plugin  ->  default
 *
 * `url`/`apiKey` additionally fall back to ovcli.conf's top-level `url` /
 * `api_key` (the connection keys every OpenViking harness reads).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_SCHEMA = [
  { name: "url", type: "string", default: "", env: ["OPENVIKING_URL", "OPENVIKING_BASE_URL"], confKey: "url" },
  { name: "apiKey", type: "string", default: "", env: ["OPENVIKING_API_KEY", "OPENVIKING_BEARER_TOKEN"], confKey: "api_key" },
  { name: "skillCatalog", type: "bool", default: true, env: "OPENVIKING_SKILL_CATALOG" },
  { name: "skillCatalogTokenBudget", type: "int", default: 1200, min: 0, max: 20000, env: "OPENVIKING_SKILL_CATALOG_TOKEN_BUDGET" },
  { name: "bypassSession", type: "bool", default: false, env: "OPENVIKING_BYPASS_SESSION" },
  { name: "bypassSessionPatterns", type: "list", default: [], env: "OPENVIKING_BYPASS_SESSION_PATTERNS", aliases: ["bypassPatterns"] },
  { name: "commitTokenThreshold", type: "int", default: 20000, min: 1, max: 1000000, env: "OPENVIKING_COMMIT_TOKEN_THRESHOLD" },
];

function envFirst(env, names) {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function toBool(raw, def) {
  if (raw === undefined || raw === null || raw === "") return def;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return def;
}

function toInt(raw, def, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function toList(raw, def) {
  if (raw === undefined || raw === null) return def;
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  // Env CSV: "a, b" -> ["a", "b"].
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}

function coerce(knob, raw) {
  switch (knob.type) {
    case "bool": return toBool(raw, knob.default);
    case "int": return toInt(raw, knob.default, knob.min, knob.max);
    case "list": return toList(raw, knob.default);
    default: return raw === undefined || raw === null ? knob.default : String(raw);
  }
}

/** Read + parse ovcli.conf (the path OPENVIKING_CLI_CONFIG_FILE overrides). */
export function loadConf(env = process.env) {
  const confPath = env.OPENVIKING_CLI_CONFIG_FILE || join(homedir(), ".openviking", "ovcli.conf");
  try {
    return JSON.parse(readFileSync(confPath, "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * Resolve every knob once. The harness section of ovcli.conf is
 * `plugin.agent_plugins` (the Agent-Plugins harness key), matching the
 * vendored proxy's connection resolver.
 */
export function resolveSettings({ env = process.env, conf = loadConf(env) } = {}) {
  const plugin = conf.plugin && typeof conf.plugin === "object" ? conf.plugin : {};
  const harness = plugin.agent_plugins && typeof plugin.agent_plugins === "object" ? plugin.agent_plugins : {};

  const out = {};
  for (const knob of CONFIG_SCHEMA) {
    const names = Array.isArray(knob.env) ? knob.env : [knob.env].filter(Boolean);
    let raw = names.length ? envFirst(env, names) : undefined;

    if (raw === undefined || raw === "") {
      if (knob.confKey !== undefined) {
        raw = conf[knob.confKey];
      } else {
        for (const key of [knob.name, ...(knob.aliases || [])]) {
          if (harness[key] !== undefined) { raw = harness[key]; break; }
          if (plugin[key] !== undefined) { raw = plugin[key]; break; }
        }
      }
    }
    out[knob.name] = coerce(knob, raw);
  }
  if (out.url) out.url = out.url.replace(/\/+$/, "");
  return out;
}

/**
 * Validation warnings for a resolved config — what ov-doctor surfaces when a
 * value was clamped to its range or looks off. Returns [] for a clean config.
 */
export function validateConfig(settings) {
  const warnings = [];
  for (const knob of CONFIG_SCHEMA) {
    const value = settings[knob.name];
    if (knob.type === "int" && typeof value === "number" && Number.isFinite(value)) {
      if (knob.min !== undefined && value < knob.min) warnings.push(`${knob.name}=${value} 低于下限 ${knob.min}（已按 ${knob.min} 生效）`);
      if (knob.max !== undefined && value > knob.max) warnings.push(`${knob.name}=${value} 高于上限 ${knob.max}（已按 ${knob.max} 生效）`);
    }
  }
  return warnings;
}
