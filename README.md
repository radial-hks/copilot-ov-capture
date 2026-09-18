# copilot-ov-capture

OpenViking 记忆平台 × GitHub Copilot（VS Code + Copilot CLI）集成插件，**一个包同时提供**：

1. **召回 + 手动沉淀**（标准 Agent Plugins 1.0）：openviking MCP 工具集（find/search/read/remember...）+ openviking-memory 技能
2. **自动召回注入**（v0.3.0+）：每条 prompt 前自动检索团队记忆并注入上下文——Copilot 无需调工具就"记得"团队经验
3. **自动捕获**（`com.github.copilot/` 扩展）：Stop hook 自动把会话内容（用户输入 + 模型回复）回放到 OpenViking，commit 触发记忆提取
4. **能力面补全**（v0.4.0）：技能写入工具（`add_skill` / `update_skill` / `validate_skill`，本地 SKILL.md `path` 上传也支持）+ `task_status` 后台任务查询 + SessionStart 开场 profile 注入 + PreCompact 压缩前归档 + PreToolUse `viking://` URI 防护 + 召回携带 session_id（对齐官方约定，激活服务端扩写与跨轮去重）

> **让 Copilot 帮你装**：把本仓库地址发给你的 Copilot 助手，加一句"读 llms.txt 帮我安装"——它会按仓库根的 [llms.txt](llms.txt) 流程引导完成（只在 user key 环节需要你提供管理员私发的凭据）。

> 前置：团队 OpenViking 服务（内网），由团队管理员为每人签发 user key。

## 快速开始（组员）

```bash
# 如果团队环境已预注册 openviking-team 市场，只需这一行
copilot plugin install openviking-copilot@openviking-team

# 如果提示 marketplace unknown，先注册一次再安装
copilot plugin marketplace add radial-hks/copilot-ov-capture
copilot plugin install openviking-copilot@openviking-team
```

凭据（一次性）：手工创建 `%USERPROFILE%\.openviking\ovcli.conf`（`url` + `api_key`），格式见 [docs/installation.md](docs/installation.md)（CLI 市场为核心路径，VS Code 图形安装为补充路径）。

装完自检：`node <插件目录>\scripts\ov-doctor.mjs`（CLI 安装的插件目录见 `copilot plugin list`，通常在 `%USERPROFILE%\.copilot\installed-plugins\openviking-team\openviking-copilot`）

## 文档

| 文档 | 内容 | 读者 |
|---|---|---|
| [docs/installation.md](docs/installation.md) | 安装路径（Copilot CLI 市场 / VS Code 图形安装）、验证清单、升级流程 | 首次安装的组员 |
| [docs/usage.md](docs/usage.md) | 自动召回/自动捕获日常使用、workspace peer、隐私边界 | 全体使用者 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 症状→处理速查表 | 全体使用者 |
| [docs/architecture.md](docs/architecture.md) | 架构、官方插件对照、回归链、管理员操作（开 key / 发版） | 维护者 |

## 支持的环境

- VS Code ≥ 1.102（Agent plugins + hooks 支持）；Copilot 插件策略未被组织禁用
- Node ≥ 18（stdio 代理与上传器共用）
- Windows / Linux / macOS：五个 hook 命令与 MCP 入口均为 `node -e` 自定位引导（env `PLUGIN_ROOT` → cwd → CLI 安装路径兜底），不依赖宿主展开 `${PLUGIN_ROOT}` 或注入环境变量，PowerShell/bash/cmd 下均原样执行；Stop/PreCompact 捕获用 Node 实现，不依赖 PowerShell 脚本

## 版本

- 0.4.11 — 许可证与 vendored 代码卫生（为上游化铺路）：新增 Apache-2.0 `LICENSE`（此前无 LICENSE 文件，仅 plugin.json 元数据；全部提交为单一作者，已确认无外部已合并 PR）与 `NOTICE`（如实列出 5 个 vendored 自 OpenViking examples/memory-plugin-shared 的文件及本地修改增量）；`ov-http.mjs` 澄清为本地自研（移除误导性的 GENERATED 头）；3 个带本地功能定制的 vendored 文件头部改为"Vendored with local modifications"诚实标注，禁止盲目 resync；plugin.json/marketplace.json license 同步 Apache-2.0。无运行时行为变化
- 0.4.10 — 修复 VS Code 下插件 MCP 服务器启动即崩（`Process exited with code 1`，stderr 为 `Cannot find module 'C:\Users\<user>\${PLUGIN_ROOT}\local-tools\mcp-entry.mjs'`）：VS Code 的 agent-plugins 宿主**不展开 mcp.json args 里的 `${PLUGIN_ROOT}` 占位符**，把字面量原样传给 node，node 按扩展宿主 cwd（用户目录）解析 → MODULE_NOT_FOUND。这是 0.4.5/0.4.6 hooks 同一宿主缺口在 MCP 面的复现——hooks 已改自定位引导而 mcp.json 一直没改。mcp.json args 改为与 hooks 相同的 `node -e` 自定位引导（env `PLUGIN_ROOT` 候选逐一校验 → cwd → `~/.copilot/installed-plugins/openviking-team/openviking-copilot` 兜底，命中后 spawn 子进程执行 `local-tools/mcp-entry.mjs`，stdio inherit）；引导串无 `$`/反引号/双引号，经 shell 与直启均安全；找不到入口时 exit 1 并在 stderr 给出插件上下文提示（不再抛 node loader 裸栈）。规范侧 `${PLUGIN_ROOT}` 展开仍是 Agent Plugins 1.0 对宿主的要求（schema 禁止插件在 env 里自带 PLUGIN_ROOT），本修复与规范宿主兼容：注入 env 的宿主命中第一候选，不注入的走兜底链。新增引导功能测试（env 候选/foreign cwd/miss 三路实跑）
- 0.4.9 — 修复 Windows 上 hook 脚本退出崩溃与输出丢失（生产级）：所有 hook 脚本（session-start/auto-recall/uri-guard/capture/hook-runner/uploader FATAL 分支）原在异步 `process.stdout.write()` 或 spawn 之后立即 `process.exit()`，Windows 上 libuv 句柄未关完即退出 → 非确定性崩溃（`uv assert src\win\async.c`，退出码 0xC0000409），且**崩溃前 stdout 未冲刷 = deny 决策/上下文注入可能整条丢失**。统一改为 `process.exitCode` + main() 返回让事件循环自然排空。附测试侧 Windows 兼容收尾：PS 5.1 `-Command` 不透传原生命令退出码（`exit 42` 变 1，Windows 测试补 `; exit $LASTEXITCODE`）；8.3 短路径名（`WANGLI~1`）与子进程 `process.cwd()` 长名不一致（期望值经 `realpathSync.native` 归一化）；`gitUserPeerId` 的 `execSync` 加 5s 超时（UNC cwd 下 git.exe 可拖 40s+）；新增 libuv 崩溃回归测试（3 脚本 × 4 轮 stdin 实跑）。Windows Node 24.16.0 + PS 5.1 实测 26/26，Linux 26/26
- 0.4.8 — 修复测试套件在 Windows 上失败（插件运行时无变化）：动态 `import(join(PLUGIN_ROOT, ...))` 传绝对 Windows 路径会抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（import specifier 必须是 URL），12 处站点统一改走 `pathToFileURL` 的 `importPluginModule` helper；hook 引导测试的 `bash -c` 改为按平台选 shell（Windows 走 `powershell -NoProfile -Command`——顺带在真 PS 下验证引导串无 `$` 插值风险，POSIX 走 bash）；fake home 环境同时设 `HOME`+`USERPROFILE`（`os.homedir()` 在 Windows 读 USERPROFILE，只设 HOME 会漏进真实用户目录，非密封）
- 0.4.7 — 修复 VS Code 会话不同步（hook 正常入队但 uploader.log 报 `transcript missing`）：VS Code 的 transcript 是 `transcripts/<session-id>.jsonl` 文件，≤0.4.6 的 `uploader.mjs` 只把 `events.jsonl` 结尾的路径当文件，其余按目录追加 `\events.jsonl`，导致读取失败、根本不发请求。两处入口（队列 `transcriptDirFromQueueEntry` 与单会话 `--transcript-dir`）放宽为任意 `.jsonl` 文件即文件，目录分支保留（CLI session-state 布局兼容）；uploader 增加 main guard（与 hook-runner 同模式），新增单元测试（四种路径形态）与离线 dry-run e2e（队列驱动 + `--transcript-dir`，fake HOME/凭据，`--dry-run` 在任何网络调用前返回）
- 0.4.6 — 修复 0.4.5 后仍复现的 `Cannot find module 'E:\scripts\hook-runner.mjs'`：`${PLUGIN_ROOT}` 在 PowerShell 是 PS 变量语法而非环境变量引用，宿主选 `command` 键经 PS 执行时无论是否注入 env 都会插值为空；且旧版 CLI 不认 `windows`/`powershell` 方言键。hooks.json 四方言统一改为 `node -e` 运行时自定位引导（env `PLUGIN_ROOT` 候选逐一校验 → cwd → `~/.copilot/installed-plugins/openviking-team/openviking-copilot` 固定路径兜底），命令串不含 `$`/反引号/嵌套双引号，三种 shell 均原样通过；找不到 runner 时静默退出 0（hook 降级不阻塞会话）
- 0.4.5 — 修复旧版 Copilot CLI 下 hooks 静默失效（`Cannot find module 'D:\scripts\hook-runner.mjs'`）：旧版 CLI 不做 `${PLUGIN_ROOT}` 文本展开、PowerShell 将其作变量插值为空；hooks.json 为每事件提供四方言命令（command/bash 用 `${PLUGIN_ROOT}`，windows/powershell 用 `$env:PLUGIN_ROOT` + 显式 powershell 前缀）；install.ps1 退役（标准安装流程为 CLI 市场 / VS Code 市场）；ov-doctor 新增 Hook 命令路径检查并把插件注册检查扩展到 CLI 安装路径
- 0.4.4 — 修复 hooks 静默失效：`timeout` 字段改为 Copilot CLI 认可的 `timeoutSec`（未知字段会导致整个 hook 条目被丢弃）；hook 命令改回 `${PLUGIN_ROOT}/scripts/hook-runner.mjs` 绝对路径（CLI 执行插件 hook 时 cwd=插件目录、VS Code 时 cwd=工作区，相对路径无法两者兼容；`${PLUGIN_ROOT}` 由宿主在命令串展开并注入环境变量）
- 0.4.3 — 官方 VS Code Agent Plugin 安装兼容：hook 命令改走 `./scripts/hook-runner.mjs`，由 runner 自定位插件根并补齐 `PLUGIN_ROOT`，避免 `${PLUGIN_ROOT}` 在 shell 命令中未注入时展开为空导致 `/scripts/*.mjs` 找不到
- 0.4.2 — 跨平台 hook 适配：五个 hook 命令统一使用 Node + `${PLUGIN_ROOT}/...` 路径；Stop/PreCompact 改为 `capture.mjs` 入队并分离启动 uploader，Windows/Linux/macOS 均可运行自动召回、开场注入、URI 防护与自动捕获
- 0.4.1 — 自动召回保守化：查询截短 400 字符 + `query_expansion`/`rewrite` 显式关闭（实测团队服务器的 expansion/rerank 在长查询下超 15s；session_id 去重收益不受影响，检索路径仍有间歇性 12s+ 抖动，hook 静默降级兜底）
- 0.4.0 — 能力面补全：本地技能工具（add/update/validate_skill + `path` 上传）+ task_status + SessionStart profile 注入 + PreCompact 归档 + uri-guard + 召回带 session_id + ov-doctor 技能接口检查
- 0.3.0 — auto-recall 注入 + ov-doctor 自诊断 + marketplace 分发
- 0.2.0 — workspace peer 推导（按仓库精准召回）
- 0.1.0 — 首版：MCP + skill + Stop 捕获管线
