#!/usr/bin/env node
/**
 * OpenViking × GitHub Copilot capture pipeline — uploader.
 *
 * Reads Copilot agent session transcripts (events.jsonl), extracts user/assistant
 * text turns, and replays them into an OpenViking server via the session API:
 *   ensure_session -> POST /api/v1/sessions/{id}/messages/batch (<=100) -> commit
 *
 * Idempotent: per-session byte-offset cursor persisted under
 * %USERPROFILE%\.openviking\copilot-capture\state\<session>.json — safe to re-run,
 * safe after crashes, self-healing across truncation/rotation.
 *
 * Credential resolution (same order as ov CLI / agent-plugins proxy):
 *   OPENVIKING_URL / OPENVIKING_API_KEY env -> %USERPROFILE%\.openviking\ovcli.conf
 *
 * Modes:
 *   node uploader.mjs --session <id> [--transcript-dir <dir>]   live single session
 *   node uploader.mjs --backfill                                 scan ~/.copilot/session-state/*
 *   node uploader.mjs --dry-run ...                              parse only, print extracted turns
 *
 * Zero npm dependencies (Node >= 18 for global fetch).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const HARNESS = "copilot";
const OV_SESSION_PREFIX = `import__${HARNESS}__`;
const BATCH_CAP = 100; // server-side batch_add_messages cap (see openviking/ingest/replay.py)
const BASE_DIR = join(homedir(), ".openviking", "copilot-capture");
const QUEUE_FILE = join(BASE_DIR, "queue.jsonl");
const STATE_DIR = join(BASE_DIR, "state");
const LOG_FILE = join(BASE_DIR, "uploader.log");
const SESSION_STATE_ROOT = join(homedir(), ".copilot", "session-state");

// ---------------------------------------------------------------- config ---

function readConfig() {
  let url = process.env.OPENVIKING_URL || "";
  let apiKey = process.env.OPENVIKING_API_KEY || "";
  if (!url || !apiKey) {
    const confPath = process.env.OPENVIKING_CLI_CONFIG_FILE
      || join(homedir(), ".openviking", "ovcli.conf");
    try {
      const conf = JSON.parse(readFileSync(confPath, "utf8"));
      url = url || conf.url || "";
      apiKey = apiKey || conf.api_key || "";
    } catch { /* fall through to error below */ }
  }
  if (!url || !apiKey) {
    throw new Error(`No OpenViking credentials: set OPENVIKING_URL/OPENVIKING_API_KEY or ${join(homedir(), ".openviking", "ovcli.conf")}`);
  }
  return { url: url.replace(/\/+$/, ""), apiKey };
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* logging must never break the pipeline */ }
  if (process.env.OV_CAPTURE_VERBOSE) console.error(line.trimEnd());
}

// ------------------------------------------------------------ peer ids ----
// Mirrors openviking/ingest/peer.py: assistant -> {harness}/{model}; user -> git
// identity of the session cwd (single-user dev harness convention), sanitized.

function safePeerId(raw) {
  const cleaned = String(raw || "").trim().replace(/[^a-zA-Z0-9_.@-]+/g, "-").replace(/-{2,}/g, "-");
  return cleaned.replace(/^[.-]+|[.-]+$/g, "") || "";
}

function assistantPeerId(model) {
  return safePeerId(`${HARNESS}/${model || "unknown-model"}`);
}

function gitUserPeerId(cwd) {
  try {
    const email = execSync("git config user.email", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (email) return safePeerId(email);
  } catch { /* not a repo / no git identity */ }
  return "copilot-local-user";
}

// ---------------------------------------------------------- transcript ----
/**
 * Parse Copilot events.jsonl lines (array of parsed objects) into ordered
 * {role, text, created_at, peer_id} message dicts, ready for the OV batch API.
 *
 * Extraction policy mirrors openviking/ingest (normalize.py): keep user and
 * assistant TEXT only; tool call inputs/outputs are low-value and dropped.
 *  - user.message: content is the raw user text.
 *  - assistant.message: grouped by turnId; the merged `final_answer` chunks are
 *    the turn's text. A turn with no final_answer falls back to its commentary
 *    text (assistant narration) so tool-only turns produce nothing.
 *  - Order: single pass over events; each assistant turn is emitted at its
 *    first appearance in the file, which preserves user/assistant interleaving.
 */
function extractMessages(events, userPeerId) {
  const turns = new Map(); // turnId -> {finals: Map(chunkIndex -> text), commentary: [], ts, model}
  const result = [];
  const emitted = new Set();

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const data = ev.data || {};
    if (ev.type === "user.message") {
      const text = typeof data.content === "string" ? data.content.trim() : "";
      if (text) {
        result.push({ role: "user", text, created_at: ev.timestamp || null, peer_id: userPeerId });
      }
    } else if (ev.type === "assistant.message") {
      const turnId = data.turnId != null ? String(data.turnId) : `noid-${ev.id || result.length}`;
      let turn = turns.get(turnId);
      if (!turn) {
        turn = { finals: new Map(), commentary: [], ts: ev.timestamp || null, model: data.model };
        turns.set(turnId, turn);
      }
      const text = typeof data.content === "string" ? data.content : "";
      if (data.phase === "final_answer") {
        const idx = data.chunkIndex != null
          ? data.chunkIndex
          : (turn.finals.size ? Math.max(...turn.finals.keys()) + 1 : 0);
        turn.finals.set(idx, (turn.finals.get(idx) || "") + text);
      } else if (text) {
        turn.commentary.push(text);
      }
      // Emit at first appearance so the turn lands in the right conversation slot.
      if (!emitted.has(turnId)) {
        emitted.add(turnId);
        const merged = turn.finals.size
          ? [...turn.finals.keys()].sort((a, b) => a - b).map(k => turn.finals.get(k)).join("").trim()
          : turn.commentary.join("\n").trim();
        if (merged) {
          result.push({ role: "assistant", text: merged, created_at: turn.ts || null, peer_id: assistantPeerId(turn.model) });
        }
      }
    }
  }
  return result;
}

/** Read transcript from a byte offset; return {events, newOffset} handling only
 *  complete lines (trailing partial line stays unconsumed). */
function readEventsFrom(transcriptPath, offset) {
  const buf = readFileSync(transcriptPath);
  if (buf.length <= offset) return { events: [], newOffset: offset, size: buf.length };
  const slice = buf.subarray(offset);
  let lastNl = slice.length - 1;
  while (lastNl >= 0 && slice[lastNl] !== 0x0a) lastNl--;
  if (lastNl < 0) return { events: [], newOffset: offset, size: buf.length };
  const text = slice.subarray(0, lastNl + 1).toString("utf8");
  const newOffset = offset + lastNl + 1;
  const events = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* tolerate torn/unknown lines */ }
  }
  return { events, newOffset, size: buf.length };
}

// ------------------------------------------------------------- OV API -----

function ovSessionId(sessionId) {
  return OV_SESSION_PREFIX + sessionId;
}

async function ovRequest(cfg, method, path, body) {
  const res = await fetch(cfg.url + path, {
    method,
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`OV ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function ensureSession(cfg, sessionId) {
  try {
    return await ovRequest(cfg, "GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  } catch (e) {
    if (e.status === 404) {
      return ovRequest(cfg, "POST", "/api/v1/sessions", { session_id: sessionId });
    }
    throw e;
  }
}

function toPayload(msg) {
  const payload = {
    role: msg.role,
    parts: [{ type: "text", text: msg.text }],
    content: msg.text,
  };
  if (msg.created_at) payload.created_at = msg.created_at;
  if (msg.peer_id) payload.peer_id = msg.peer_id;
  return payload;
}

async function uploadSession(cfg, sessionId, transcriptPath, cwd, { dryRun = false } = {}) {
  const statePath = join(STATE_DIR, `${sessionId}.json`);
  let offset = 0;
  if (existsSync(statePath)) {
    try { offset = JSON.parse(readFileSync(statePath, "utf8")).byte_offset || 0; } catch { offset = 0; }
  }
  const { events, newOffset } = readEventsFrom(transcriptPath, offset);
  if (!events.length) {
    log(`session ${sessionId}: no new events (offset ${offset})`);
    return { added: 0, committed: false };
  }
  const userPeerId = cwd ? gitUserPeerId(cwd) : "copilot-local-user";
  const messages = extractMessages(events, userPeerId);
  if (dryRun) {
    console.log(`[dry-run] session ${sessionId}: ${events.length} events -> ${messages.length} turns (offset ${offset} -> ${newOffset})`);
    for (const m of messages) console.log(`  ${m.role.padEnd(9)} peer=${m.peer_id} ${m.text.slice(0, 80).replace(/\n/g, " ")}`);
    return { added: messages.length, committed: false };
  }
  if (!messages.length) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath, JSON.stringify({ byte_offset: newOffset }));
    log(`session ${sessionId}: ${events.length} events parsed, 0 text turns; cursor advanced`);
    return { added: 0, committed: false };
  }

  const ovSid = ovSessionId(sessionId);
  await ensureSession(cfg, ovSid);

  let added = 0;
  for (let start = 0; start < messages.length; start += BATCH_CAP) {
    const chunk = messages.slice(start, start + BATCH_CAP).map(toPayload);
    const res = await ovRequest(cfg, "POST",
      `/api/v1/sessions/${encodeURIComponent(ovSid)}/messages/batch`,
      { messages: chunk });
    added += Number((res && res.result && res.result.added) != null ? res.result.added : chunk.length);
  }
  await ovRequest(cfg, "POST", `/api/v1/sessions/${encodeURIComponent(ovSid)}/commit`, { keep_recent_count: 0 });

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ byte_offset: newOffset }));
  log(`session ${sessionId}: +${added} messages, committed (offset ${offset} -> ${newOffset})`);
  return { added, committed: true };
}

// ------------------------------------------------------------- driver -----

function transcriptDirFromQueueEntry(entry) {
  // transcript_path may point at the events.jsonl file or at the session dir.
  let p = entry.transcript_path || "";
  if (!p && entry.session_id) p = join(SESSION_STATE_ROOT, entry.session_id);
  if (/events\.jsonl$/i.test(p)) return { dir: dirname(p), file: p };
  return { dir: p, file: join(p, "events.jsonl") };
}

async function processQueue(cfg, { dryRun = false } = {}) {
  if (!existsSync(QUEUE_FILE)) return;
  const lines = readFileSync(QUEUE_FILE, "utf8").split("\n").filter(t => t.trim());
  const bySession = new Map();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.session_id) bySession.set(e.session_id, e); // latest entry wins
  }
  const done = [];
  for (const [sessionId, entry] of bySession) {
    const { file } = transcriptDirFromQueueEntry(entry);
    if (!existsSync(file)) { log(`session ${sessionId}: transcript missing (${file})`); continue; }
    try {
      const r = await uploadSession(cfg, sessionId, file, entry.cwd, { dryRun });
      if (!dryRun) done.push(sessionId);
    } catch (e) {
      log(`session ${sessionId}: UPLOAD FAILED: ${e.message}`);
    }
  }
  if (!dryRun && done.length) {
    // Rewrite queue keeping only failed/missing sessions (idempotent cleanup).
    const keep = lines.filter(line => {
      try { return !done.includes(JSON.parse(line).session_id); } catch { return false; }
    });
    writeFileSync(QUEUE_FILE, keep.length ? keep.join("\n") + "\n" : "");
    log(`queue: ${done.length} session(s) processed and drained`);
  }
}

async function backfill(cfg, { dryRun = false } = {}) {
  if (!existsSync(SESSION_STATE_ROOT)) { log("no session-state root, nothing to backfill"); return; }
  for (const name of readdirSync(SESSION_STATE_ROOT)) {
    const file = join(SESSION_STATE_ROOT, name, "events.jsonl");
    if (!existsSync(file)) continue;
    try {
      await uploadSession(cfg, name, file, null, { dryRun });
    } catch (e) {
      log(`backfill ${name}: FAILED: ${e.message}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  mkdirSync(STATE_DIR, { recursive: true });
  const cfg = readConfig();
  if (args.includes("--backfill")) {
    await backfill(cfg, { dryRun });
    return;
  }
  const sIdx = args.indexOf("--session");
  if (sIdx >= 0 && args[sIdx + 1]) {
    const sessionId = args[sIdx + 1];
    const tIdx = args.indexOf("--transcript-dir");
    const dir = tIdx >= 0 ? args[tIdx + 1] : join(SESSION_STATE_ROOT, sessionId);
    const file = /events\.jsonl$/i.test(dir) ? dir : join(dir, "events.jsonl");
    if (!existsSync(file)) { log(`session ${sessionId}: transcript missing (${file})`); process.exit(0); }
    await uploadSession(cfg, sessionId, file, null, { dryRun });
    return;
  }
  await processQueue(cfg, { dryRun });
}

main().catch(e => { log(`FATAL: ${e.message}`); console.error(e.message); process.exit(1); });
