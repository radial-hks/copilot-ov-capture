#!/usr/bin/env node

/**
 * SessionStart hook for VS Code Copilot: profile injection.
 *
 * Port of the official Claude Code plugin's session-start behavior: at the
 * first prompt of a session, inject the user's profile.md plus a compact
 * listing of available preference/entity memories as <openviking-context>,
 * so Copilot starts with "who the user is / what is known about them" —
 * the same block 9 of the official harness integrations build via the
 * shared profile-inject module (vendored at lib/profile-inject.mjs).
 *
 * VS Code hook contract: reads the SessionStart JSON from stdin, writes
 * { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }
 * to stdout, exit 0. Failures degrade to a silent no-op — session start is
 * never blocked.
 *
 * Budget: 6000 tokens (the official thin-hook tier), CJK-aware via the
 * vendored estimator.
 */

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { readConfig, workspacePeerId, makeFetchJSON } from "./lib/ov-common.mjs";
import { buildProfileBlock } from "./lib/profile-inject.mjs";

const BUDGET_TOKENS = 6000;

/**
 * Profile-injection logic, exported for in-process testing. Returns the
 * hook output object ({} on every skip/failure path).
 */
export async function runSessionStart(ev = {}) {
  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) return {}; // not configured yet — silent

  const peer = workspacePeerId(ev.cwd || process.cwd());
  const fetchJSON = makeFetchJSON(cfg, { peerId: peer });

  try {
    const built = await buildProfileBlock(fetchJSON, BUDGET_TOKENS, peer);
    if (!built || !built.block) return {};
    const context = `<openviking-context source="session-start" peer="${peer || "user-level"}">\n`
      + `${built.block}\n</openviking-context>`;
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
  } catch { return {}; } // any failure — never block the session
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let ev = {};
  // process.exit() right after an async process.stdout.write() crashes node on
  // Windows (libuv uv_async assert, 0xC0000409). main() returning lets the
  // event loop drain and node exit with code 0 after the write is flushed.
  try { ev = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return; }
  const out = await runSessionStart(ev);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main().catch(() => {}); // a hook must never crash or block the session
}