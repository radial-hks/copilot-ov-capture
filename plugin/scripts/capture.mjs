#!/usr/bin/env node

/**
 * Cross-platform Stop/PreCompact hook for the OpenViking capture pipeline.
 *
 * The hook stays fast: it appends the session to the local queue, mirrors the
 * raw event for diagnostics, then starts uploader.mjs detached. The uploader is
 * idempotent, so double launches and offline failures are safe.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_DIR = join(homedir(), ".openviking", "copilot-capture");

export function queueCaptureEvent(ev = {}, { baseDir = DEFAULT_BASE_DIR, rawInput = "" } = {}) {
  if (ev.hook_event_name !== "Stop" && ev.hook_event_name !== "PreCompact") return false;
  if (!ev.session_id) return false;

  mkdirSync(baseDir, { recursive: true });
  const entry = {
    session_id: ev.session_id,
    transcript_path: ev.transcript_path,
    cwd: ev.cwd,
    timestamp: ev.timestamp,
  };
  appendFileSync(join(baseDir, "queue.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  appendFileSync(join(baseDir, "events-mirror.jsonl"), `${rawInput || JSON.stringify(ev)}\n`, "utf8");
  return true;
}

export function startUploader({ baseDir = DEFAULT_BASE_DIR, pluginRoot = process.env.PLUGIN_ROOT } = {}) {
  const root = pluginRoot || dirname(dirname(fileURLToPath(import.meta.url)));
  const uploader = join(root, "scripts", "uploader.mjs");
  if (!existsSync(uploader)) return false;

  mkdirSync(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "");
  const child = spawn(process.execPath, [uploader], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  child.unref();
  appendFileSync(join(baseDir, `uploader-${stamp}.out`), "", "utf8");
  appendFileSync(join(baseDir, `uploader-${stamp}.err`), "", "utf8");
  return true;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const rawInput = await readStdin();
  let ev = {};
  try { ev = JSON.parse(rawInput); } catch { process.exit(0); }
  if (queueCaptureEvent(ev, { rawInput })) startUploader();
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main();
}