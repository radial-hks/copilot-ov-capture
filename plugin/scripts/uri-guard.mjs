#!/usr/bin/env node

/**
 * PreToolUse guard for viking:// URIs (VS Code Copilot hooks).
 *
 * viking:// URIs address OpenViking server resources, not local files.
 * When the model feeds one to a built-in file tool, the call fails or worse
 * silently writes a local file named "viking:...". This hook mirrors the
 * official harness plugins' uri-guard, with tool-specific redirection:
 *   - openviking MCP tools (tool names containing "openviking") legitimately
 *     take viking:// arguments -> allow untouched
 *   - file-ish tools with a viking:// value in a path-like field -> deny,
 *     spelling out the equivalent openviking_* call; a write/edit aimed at a
 *     skill URI redirects to openviking_add_skill (MCP write/edit cannot touch
 *     skills/)
 *   - terminal/command tools carrying a viking:// string -> allow, but attach
 *     a notice so the model doesn't confuse shell output with OV content
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
import {
  buildGuardMessage,
  buildGuardNotice,
  isSkillUri,
  addSkillExample,
  normalizeToolName,
  findVikingUriInValue,
} from "./lib/uri-guard.mjs";

// Field names that carry filesystem paths in VS Code tool inputs
// (camelCase) and Claude-style inputs (snake_case).
const PATH_KEY_RE = /(^|_)(path|file|dir|folder|location|uri|uris|root|cwd)(_|$)|^(path|file|dir|folder|location|uri|uris|root|cwd)/i;
const VIKING_PREFIX = "viking://";
const TERMINAL_RE = /terminal|shell|bash|command|run_|powershell/i;

// Copilot tool names -> OpenViking MCP equivalents. Examples are valid calls
// against the server's own schemas. A tool absent from this table still gets
// denied (generic message) so an unknown file tool is never left open.
function readHint(uri) {
  return { tool: "openviking_read", example: `openviking_read(uris=["${uri}"])` };
}
function writeHint(uri) {
  return isSkillUri(uri)
    ? { tool: "openviking_add_skill", example: addSkillExample(uri, { call: "openviking_add_skill" }) }
    : { tool: "openviking_write", example: `openviking_write(uri="${uri}", content="...")` };
}
function editHint(uri) {
  return isSkillUri(uri)
    ? { tool: "openviking_add_skill", example: addSkillExample(uri, { call: "openviking_add_skill", edited: true }) }
    : { tool: "openviking_edit", example: `openviking_edit(uri="${uri}", old_string="...", new_string="...")` };
}
function grepHint(uri, input) {
  const pattern = typeof input?.pattern === "string" ? input.pattern.replaceAll('"', '\\"') : "";
  return { tool: "openviking_grep", example: `openviking_grep(uri="${uri}", pattern=["${pattern}"])` };
}
function globHint(uri) {
  return { tool: "openviking_glob", example: `openviking_glob(uri="${uri}", pattern="**/*")` };
}
function listHint(uri) {
  return { tool: "openviking_list", example: `openviking_list(uri="${uri}")` };
}
const SHELL_HINT = (uri) => ({
  tool: "openviking_read or openviking_search",
  example: `openviking_read(uris=["${uri}"])`,
});

const TOOL_HINTS = {
  read_file: readHint,
  read: readHint,
  create_file: writeHint,
  write_file: writeHint,
  write: writeHint,
  edit_file: editHint,
  edit: editHint,
  grep_search: grepHint,
  grep: grepHint,
  search_file: globHint,
  glob: globHint,
  list_files: listHint,
  list_dir: listHint,
  ls: listHint,
};

const GENERIC_DENY = { tool: "the openviking MCP tools (read / list / tree / find)" };

function findVikingPath(toolInput) {
  for (const [key, value] of Object.entries(toolInput)) {
    if (PATH_KEY_RE.test(key) && typeof value === "string" && value.startsWith(VIKING_PREFIX)) {
      return value;
    }
  }
  return null;
}

export function decideUriGuard(input) {
  if (!input || typeof input !== "object") return null;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName) return null;
  // Our own MCP tools take viking:// URIs by design — never second-guess them.
  if (/openviking/i.test(toolName)) return null;

  const toolInput = input.tool_input && typeof input.tool_input === "object"
    ? input.tool_input
    : {};

  const vikingPath = findVikingPath(toolInput);

  if (!vikingPath) {
    // Terminal commands may embed a viking:// string (e.g. curl on the server
    // API) — allowed, with a notice. Only command-ish string values count.
    const hasVikingString = Object.values(toolInput)
      .some((value) => typeof value === "string" && value.includes(VIKING_PREFIX));
    if (hasVikingString && TERMINAL_RE.test(toolName)) {
      const uri = findVikingUriInValue(toolInput) || VIKING_PREFIX;
      return { systemMessage: buildGuardNotice(uri, SHELL_HINT(uri)) };
    }
    return null;
  }

  if (TERMINAL_RE.test(toolName)) {
    return { systemMessage: buildGuardNotice(vikingPath, SHELL_HINT(vikingPath)) };
  }

  const hintFn = TOOL_HINTS[normalizeToolName(toolName)];
  const hint = hintFn ? hintFn(vikingPath, toolInput) : GENERIC_DENY;
  return {
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: buildGuardMessage(vikingPath, hint),
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
