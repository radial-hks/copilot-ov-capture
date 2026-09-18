#!/usr/bin/env node

/**
 * PreToolUse guard for viking:// URIs (VS Code Copilot hooks).
 *
 * viking:// URIs address OpenViking server resources, not local files.
 * When the model feeds one to a built-in file tool, the call fails or worse
 * silently writes a local file named "viking:...". This hook mirrors the
 * official thin-hook plugins' uri-guard:
 *   - openviking MCP tools (tool names containing "openviking") legitimately
 *     take viking:// arguments -> allow untouched
 *   - file-ish tools with a viking:// value in a path-like field -> deny,
 *     pointing the model at the MCP tools instead
 *   - terminal/command tools carrying a viking:// string -> allow, but attach
 *     a hint so the model doesn't confuse shell output with OV content
 *   - search `pattern`/`query` text is never treated as a path (only
 *     path-like keys are checked)
 *
 * Hook contract: reads the PreToolUse JSON from stdin, writes a JSON
 * decision to stdout, exit 0. Never blocks on anything but this decision —
 * the hook budget is 10s and the whole body is synchronous.
 *
 * VS Code note: hook matchers are parsed but IGNORED (docs: "hooks run on
 * every matching event"), so filtering by tool name happens here, not in
 * hooks.json.
 */

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

// Field names that carry filesystem paths in VS Code tool inputs
// (camelCase) and Claude-style inputs (snake_case).
const PATH_KEY_RE = /(^|_)(path|file|dir|folder|location|uri|uris|root|cwd)(_|$)|^(path|file|dir|folder|location|uri|uris|root|cwd)/i;
const VIKING_PREFIX = "viking://";
const TERMINAL_RE = /terminal|shell|bash|command|run_|powershell/i;

export function decideUriGuard(input) {
  if (!input || typeof input !== "object") return null;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName) return null;
  // Our own MCP tools take viking:// URIs by design — never second-guess them.
  if (/openviking/i.test(toolName)) return null;

  const toolInput = input.tool_input && typeof input.tool_input === "object"
    ? input.tool_input
    : {};

  const vikingPath = Object.entries(toolInput)
    .filter(([key]) => PATH_KEY_RE.test(key))
    .some(([, value]) => typeof value === "string" && value.startsWith(VIKING_PREFIX));

  if (!vikingPath) {
    // Terminal commands may embed a viking:// string (e.g. curl on the server
    // API) — allowed, with a hint. Only check command-ish string values.
    const hasVikingString = Object.values(toolInput)
      .some((value) => typeof value === "string" && value.includes(VIKING_PREFIX));
    if (hasVikingString && TERMINAL_RE.test(toolName)) {
      return {
        systemMessage: "Note: viking:// URIs are OpenViking server resources, not local files. Use the openviking MCP tools (read / list / tree / find) to access their content.",
      };
    }
    return null;
  }

  if (TERMINAL_RE.test(toolName)) {
    return {
      systemMessage: "Note: viking:// URIs are OpenViking server resources, not local files. Use the openviking MCP tools (read / list / tree / find) to access their content.",
    };
  }

  return {
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason:
        "viking:// URIs address OpenViking server resources, not local files. Use the openviking MCP tools (read / list / tree / find) instead.",
    },
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let ev = {};
  // process.exit() right after an async process.stdout.write() crashes node on
  // Windows (libuv uv_async assert, 0xC0000409). Returning lets the loop drain
  // so the write flushes before node exits 0.
  try {
    ev = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return; }
  const decision = decideUriGuard(ev);
  if (!decision) return;
  process.stdout.write(JSON.stringify(decision) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main().catch(() => {}); // a hook must never crash or block the session
}