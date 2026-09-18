#!/usr/bin/env node

/**
 * ov-doctor: self-diagnosis for the OpenViking Copilot plugin.
 * Ported concept from the official Claude Code plugin's ov-memory-doctor skill.
 *
 * Usage:  node ov-doctor.mjs
 * Checks, in order: Node version, credentials (ovcli.conf), server reachability
 * + auth, skills REST endpoint (local skill tools depend on it), workspace
 * peer derivation, capture pipeline state (queue/cursors), recent uploader
 * results, VS Code settings registration.
 * Exits 0 always; prints a PASS/FAIL table with fix hints (Chinese, team-facing).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const results = [];
function check(name, ok, detail, fix) {
  results.push({ name, ok, detail, fix });
}

const HOME = homedir();
const CAPTURE_DIR = join(HOME, ".openviking", "copilot-capture");

// 1. Node
try {
  const v = process.versions.node.split(".");
  check("Node >= 18", Number(v[0]) >= 18, `当前 ${process.versions.node}`, "安装 Node 18+（https://nodejs.org）");
} catch { check("Node", false, "无法检测", ""); }

// 2. credentials
let cfg = { url: "", apiKey: "" };
const confPath = join(HOME, ".openviking", "ovcli.conf");
if (existsSync(confPath)) {
  try {
    const conf = JSON.parse(readFileSync(confPath, "utf8"));
    cfg.url = conf.url || "";
    cfg.apiKey = conf.api_key || "";
      check("凭据文件 ovcli.conf", Boolean(cfg.url && cfg.apiKey),
        `${confPath} (url=${cfg.url || "缺失"})`,
        "手工编辑该文件补全 url/api_key，格式见 docs/installation.md（一行 JSON）");
  } catch (e) {
    check("凭据文件 ovcli.conf", false, `${confPath} 解析失败: ${e.message}`, "检查 JSON 语法");
  }
} else {
  check("凭据文件 ovcli.conf", false, `未找到 ${confPath}`,
    "手工创建 %USERPROFILE%\\.openviking\\ovcli.conf，内容 {\"url\":\"<服务器地址>\",\"api_key\":\"<你的user-key>\"}，详见 docs/installation.md");
}
if (process.env.OPENVIKING_URL) check("环境变量覆盖", true, "OPENVIKING_URL 已设置（优先于 ovcli.conf）", "");

// 3. server reachability + auth
if (cfg.url && cfg.apiKey) {
  try {
    const res = await fetch(cfg.url + "/health", { signal: AbortSignal.timeout(8000) });
    check("服务连通", res.ok, `HTTP ${res.status}`, res.ok ? "" : "检查内网/VPN 是否连通，服务器是否在运行");
    if (res.ok) {
      try {
        const s = await fetch(cfg.url + "/api/v1/sessions?limit=1", {
          headers: { "Authorization": `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        check("API Key 鉴权", s.status !== 401 && s.status !== 403, `HTTP ${s.status}`,
          s.status === 401 ? "key 错误或已失效——找管理员重发 user key" : "");
      } catch { check("API Key 鉴权", false, "请求失败", ""); }
      try {
        const sk = await fetch(cfg.url + "/api/v1/skills?node_limit=1", {
          headers: { "Authorization": `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        check("技能 REST 接口", sk.ok, `HTTP ${sk.status}`,
          sk.status === 404 ? "服务器版本过旧，无 /api/v1/skills（add_skill/update_skill 工具不可用）——找管理员升级服务端" : "");
      } catch { check("技能 REST 接口", false, "请求失败", "确认服务器可达"); }
    }
  } catch (e) {
    check("服务连通", false, e.message, `确认 ${cfg.url} 可达（内网/VPN）`);
  }
}

// 4. workspace peer derivation (run in the directory the user runs doctor from, or CWD)
try {
  let cwd = process.argv[2] || process.cwd();
  let peer = "";
  const root = (function findRoot(dir) {
    while (true) {
      if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".openviking", "config.json"))) return dir;
      const p = dirname(dir);
      if (p === dir) return null;
      dir = p;
    }
  })(cwd);
  if (root) {
    try {
      const gc = readFileSync(join(root, ".git", "config"), "utf8");
      const m = gc.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
      if (m) {
        const remote = m[1].replace(/^[a-z]+@/i, "").replace(/\.git$/, "").replace(/[:/]/g, "-").toLowerCase();
        peer = remote;
      }
    } catch { /* no git config */ }
    try {
      const conf = JSON.parse(readFileSync(join(root, ".openviking", "config.json"), "utf8"));
      if (conf?.peer?.id) peer = conf.peer.id;
    } catch { /* not configured */ }
  }
  check("工作区 peer", true,
    root ? `${peer ? `peer=${peer}` : "非 git 目录（记忆进用户级）"} (root=${root})` : "当前目录不是工作区（记忆进用户级）",
    "");
} catch { /* non-fatal */ }

// 5. capture pipeline state
if (existsSync(CAPTURE_DIR)) {
  const queue = join(CAPTURE_DIR, "queue.jsonl");
  if (existsSync(queue)) {
    const pending = readFileSync(queue, "utf8").split("\n").filter(t => t.trim()).length;
    check("捕获队列", pending === 0, pending ? `${pending} 个会话待重传` : "空（正常）",
      pending ? "服务器可能不可达；可手动重试: node <插件>/scripts/uploader.mjs" : "");
  } else {
    check("捕获队列", true, "空（尚未触发过捕获）", "");
  }
  const stateDir = join(CAPTURE_DIR, "state");
  if (existsSync(stateDir)) {
    const cursors = readdirSync(stateDir).filter(f => f.endsWith(".json")).length;
    check("捕获游标", true, `${cursors} 个会话已建立游标`, "");
  }
  const log = join(CAPTURE_DIR, "uploader.log");
  if (existsSync(log)) {
    const tail = readFileSync(log, "utf8").split("\n").filter(t => t.trim()).slice(-3);
    const hasFailure = tail.some(l => l.includes("FAILED"));
    check("最近上传", !hasFailure, tail.join(" | ").slice(0, 200) || "无记录",
      hasFailure ? "看 uploader.log 中 FAILED 行的详细错误" : "");
  }
} else {
  check("捕获管线", false, `${CAPTURE_DIR} 不存在（尚未触发过任何 Copilot 会话捕获）`,
    "正常——首次 Copilot 会话结束后自动创建");
}
// 6. plugin installation (CLI marketplace / VS Code marketplace / pluginLocations)
const PLUGIN_ROOT_DIR = dirname(fileURLToPath(import.meta.url)) ? join(dirname(fileURLToPath(import.meta.url)), "..") : "";
{
  // CLI-installed copies are auto-discovered by VS Code; pluginLocations is
  // only needed for manual local installs.
  const cliInstalled = existsSync(join(HOME, ".copilot", "installed-plugins"))
    && (function find() {
      try {
        for (const mp of readdirSync(join(HOME, ".copilot", "installed-plugins"))) {
          const p = join(HOME, ".copilot", "installed-plugins", mp, "openviking-copilot");
          if (existsSync(p)) return p;
        }
      } catch { /* not installed via CLI */ }
      return "";
    })();
  const codeSettings = [join(process.env.APPDATA || "", "Code", "User", "settings.json")].find(existsSync);
  let registered = Boolean(cliInstalled);
  let detail = cliInstalled ? `CLI 安装于 ${cliInstalled}（VS Code 自动发现）` : "";
  if (!registered && codeSettings) {
    try {
      const s = JSON.parse(readFileSync(codeSettings, "utf8"));
      const enabled = s["chat.plugins.enabled"];
      const locs = s["chat.pluginLocations"] || {};
      const mkt = (s["chat.plugins.marketplaces"] || []).some(m => String(m).includes("copilot-ov-capture"));
      const locRegistered = Object.keys(locs).some(k => k.includes("copilot-ov") && locs[k] === true);
      registered = locRegistered || mkt;
      detail = `chat.plugins.enabled=${enabled === true}, pluginLocations=${locRegistered}, marketplaces=${mkt} (${codeSettings})`;
    } catch (e) {
      detail = `settings.json 解析失败: ${e.message}`;
    }
  }
  check("插件注册", registered, detail || "未找到任何安装痕迹（CLI/VS Code 市场/pluginLocations 均无）",
    registered ? "" : "按 docs/installation.md 标准流程安装：copilot plugin install openviking-copilot@openviking-team，或 VS Code 市场安装；装完 Reload Window");
}

// 7. hook wiring: every command dialect must resolve to a real script
{
  const hooksPath = join(PLUGIN_ROOT_DIR, "com.github.copilot", "hooks", "hooks.json");
  let ok = false;
  let detail = "";
  if (!existsSync(hooksPath)) {
    detail = `未找到 ${hooksPath}`;
  } else try {
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks || {};
    const dialects = ["command", "windows", "powershell", "bash"];
    let checked = 0;
    for (const entries of Object.values(hooks)) {
      for (const hook of entries || []) {
        for (const d of dialects) {
          const cmd = hook[d];
          if (typeof cmd !== "string") continue;
          const m = /\$\{PLUGIN_ROOT\}|\$env:PLUGIN_ROOT/.exec(cmd);
          if (!m) { ok = false; detail = `${d} 命令缺少 PLUGIN_ROOT 引用`; checked = -1; break; }
          const script = "scripts/hook-runner.mjs";
          if (!cmd.includes(script)) { ok = false; detail = `${d} 命令未指向 ${script}`; checked = -1; break; }
          checked++;
        }
        if (checked < 0) break;
      }
      if (checked < 0) break;
    }
    if (checked > 0) {
      ok = existsSync(join(PLUGIN_ROOT_DIR, "scripts", "hook-runner.mjs"));
      detail = ok
        ? `四方言命令均指向 scripts/hook-runner.mjs（command/windows/powershell/bash 共 ${checked} 处）`
        : `scripts/hook-runner.mjs 不存在于 ${PLUGIN_ROOT_DIR}`;
    }
  } catch (e) {
    detail = `hooks.json 解析失败: ${e.message}`;
  }
  check("Hook 命令路径", ok, detail,
    "hooks.json 损坏或被改写——重新安装插件：copilot plugin install openviking-copilot@openviking-team（CLI 有缓存陷阱，重装才会覆盖）");
}

// report
const W = 22;
console.log("\nOpenViking Copilot 插件自诊断");
console.log("=".repeat(60));
for (const r of results) {
  console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  if (r.detail) console.log(`       ${r.detail}`);
  if (!r.ok && r.fix) console.log(`       → 修复: ${r.fix}`);
}
const fails = results.filter(r => !r.ok).length;
console.log("=".repeat(60));
console.log(`${results.length - fails}/${results.length} 项通过${fails ? `，${fails} 项需处理` : "，一切正常"}`);
