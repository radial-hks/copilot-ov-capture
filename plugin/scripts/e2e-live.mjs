#!/usr/bin/env node

/**
 * Live end-to-end gate for the capture pipeline, run against a REAL OpenViking
 * server. Not part of CI (it needs a live server + credentials); the mock-server
 * suite in plugin/plugin.test.mjs cannot prove that messages actually land,
 * commit, and produce an archive.
 *
 *   node scripts/e2e-live.mjs
 *
 * Credentials resolve exactly like every other script: OPENVIKING_URL /
 * OPENVIKING_API_KEY env, else ~/.openviking/ovcli.conf. Verifies:
 *
 *   1. health + auth
 *   2. capture — a synthetic transcript uploads (batch) and commits (--commit),
 *      and the OV session reports the messages and a commit
 *   3. resume — the session /context yields an archive overview (best-effort:
 *      extraction is async; a not-ready result is reported, not failed)
 *
 * The test session (import__copilot__e2e-live-<ts>) and its local cursor are
 * cleaned up afterwards so a dev server's memories stay clean. Exits 0 on all
 * pass, 1 if any hard check fails.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveSettings } from "./lib/config-schema.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const UPLOADER = join(SCRIPTS_DIR, "uploader.mjs");
const TEST_SESSION = `e2e-live-${Date.now()}`;
const OV_SESSION = `import__copilot__${TEST_SESSION}`;
const STATE_FILE = join(homedir(), ".openviking", "copilot-capture", "state", `${TEST_SESSION}.json`);

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function ovRequest(cfg, method, path) {
  const res = await fetch(cfg.url + path, {
    method,
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, result: json?.result ?? null };
}

function runUploader(cfg, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPLOADER, ...args], {
      env: { ...process.env, OPENVIKING_URL: cfg.url, OPENVIKING_API_KEY: cfg.apiKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function main() {
  const cfg = resolveSettings();
  if (!cfg.url || !cfg.apiKey) {
    check("凭据", false, "未配置 OPENVIKING_URL/OPENVIKING_API_KEY 或 ~/.openviking/ovcli.conf");
    process.exitCode = 1;
    return;
  }

  console.log(`\nOpenViking 捕获管线 live E2E  —  服务器 ${cfg.url}  会话 ${OV_SESSION}\n`);

  // 1. health + auth
  const health = await ovRequest(cfg, "GET", "/health");
  check("服务连通", health.ok, `HTTP ${health.status}`);
  if (health.ok) {
    const auth = await ovRequest(cfg, "GET", "/api/v1/sessions?limit=1");
    check("API Key 鉴权", auth.status !== 401 && auth.status !== 403, `HTTP ${auth.status}`);
  }

  // 2. capture E2E
  const tmpDir = join(homedir(), ".openviking", "copilot-capture", `e2e-tmp-${TEST_SESSION}`);
  const transcriptFile = join(tmpDir, `${TEST_SESSION}.jsonl`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(transcriptFile, [
    JSON.stringify({ id: "e1", timestamp: new Date().toISOString(), type: "user.message", data: { content: "e2e-live capture test: safe to ignore — 记录一条测试消息" } }),
    JSON.stringify({ id: "e2", timestamp: new Date().toISOString(), type: "assistant.message", data: { turnId: "t1", phase: "final_answer", chunkIndex: 0, content: "acknowledged" } }),
    "",
  ].join("\n"));

  try {
    const run = await runUploader(cfg, ["--session", TEST_SESSION, "--transcript-dir", transcriptFile, "--cwd", tmpDir, "--commit"]);
    check("上传器退出", run.code === 0, run.err.trim().split("\n").slice(-1)[0] || `exit ${run.code}`);

    const meta = await ovRequest(cfg, "GET", `/api/v1/sessions/${encodeURIComponent(OV_SESSION)}`);
    check("会话落盘", meta.ok && ((meta.result?.total_message_count ?? 0) > 0 || (meta.result?.message_count ?? 0) > 0),
      `total_message_count=${meta.result?.total_message_count ?? "?"} (commit 后 keep_recent_count=0 会归档，active message_count 归零)`);
    check("提交归档", meta.ok && (meta.result?.commit_count ?? 0) >= 1,
      `commit_count=${meta.result?.commit_count ?? "?"}`);

    // 3. resume E2E (best-effort: phase 2 extraction is async)
    if (meta.ok && (meta.result?.commit_count ?? 0) >= 1) {
      let overview = "";
      for (let i = 0; i < 8 && !overview; i++) {
        const ctx = await ovRequest(cfg, "GET", `/api/v1/sessions/${encodeURIComponent(OV_SESSION)}/context?token_budget=1000`);
        overview = typeof ctx.result?.latest_archive_overview === "string" ? ctx.result.latest_archive_overview.trim() : "";
        if (!overview) await new Promise((r) => setTimeout(r, 1500));
      }
      if (overview) {
        check("续跑 overview", true, `已生成 ${overview.length} 字符`);
      } else {
        console.log("[SKIP] 续跑 overview — 尚未就绪（异步抽取，非失败）");
      }
    }
  } finally {
    // Cleanup: delete the test session (best-effort) and the local cursor.
    await ovRequest(cfg, "DELETE", `/api/v1/sessions/${encodeURIComponent(OV_SESSION)}`);
    rmSync(tmpDir, { recursive: true, force: true });
    if (existsSync(STATE_FILE)) rmSync(STATE_FILE, { force: true });
  }

  console.log("");
  console.log(failures.length === 0
    ? `全部通过（${OV_SESSION} 已清理）`
    : `${failures.length} 项失败: ${failures.join(", ")}`);
}

main()
  .then(() => { process.exitCode = failures.length ? 1 : 0; })
  .catch((e) => { console.error(`FATAL: ${e.message}`); process.exitCode = 1; });
