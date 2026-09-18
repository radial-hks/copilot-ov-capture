#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_BY_NAME = new Map([
  ["session-start", "session-start.mjs"],
  ["auto-recall", "auto-recall.mjs"],
  ["uri-guard", "uri-guard.mjs"],
  ["capture", "capture.mjs"],
]);

export function pluginRootFromRunner() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function resolveHookScript(name, pluginRoot = pluginRootFromRunner()) {
  const script = SCRIPT_BY_NAME.get(name);
  if (!script) return null;
  const fullPath = resolvePath(join(pluginRoot, "scripts", script));
  return fullPath.startsWith(resolvePath(pluginRoot) + sep) ? fullPath : null;
}

export function runHook(name, args = process.argv.slice(3), { pluginRoot = pluginRootFromRunner() } = {}) {
  const script = resolveHookScript(name, pluginRoot);
  if (!script || !existsSync(script)) return Promise.resolve(0);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: pluginRoot,
      env: { ...process.env, PLUGIN_ROOT: pluginRoot },
      stdio: "inherit",
    });
    child.on("error", () => resolve(0));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  const code = await runHook(process.argv[2]);
  // process.exit() while the spawned child's libuv handles are still closing
  // crashes node on Windows (uv assert in src/win/async.c). Setting exitCode
  // lets the loop drain, then node exits naturally with the hook's code.
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main();
}