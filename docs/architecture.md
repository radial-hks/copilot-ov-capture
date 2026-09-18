# 架构与维护指南

> 本文从 README 分拆，面向维护者（仓库 owner / 后续接手人）。组员文档见 [installation.md](installation.md) / [usage.md](usage.md) / [troubleshooting.md](troubleshooting.md)。

```
plugin/                          # Agent Plugins 1.0 包（分发单元）
├── plugin.json                  # 清单（name: openviking-copilot）
├── mcp.json                     # stdio MCP 代理声明（入口在 local-tools/）
├── servers/                     # 官方 mcp-proxy.mjs + shared（勿改，上游同步）
├── local-tools/                 # 本地扩展（上游同步安全区，servers/ 覆盖不影响）
│   ├── mcp-entry.mjs            # MCP 入口：共享代理核心 + localToolProvider
│   └── skill-tools.mjs          # add/update/validate_skill + task_status（REST）
├── skills/                      # 官方 openviking-memory / ov-memory-troubleshoot（勿改）
├── scripts/
│   ├── hook-runner.mjs          # hook 入口：自定位插件根，补齐 PLUGIN_ROOT 后转发
│   ├── auto-recall.mjs          # UserPromptSubmit：检索+注入 <openviking-context>（带 session_id）
│   ├── session-start.mjs        # SessionStart：profile + 可用记忆清单注入
│   ├── uri-guard.mjs            # PreToolUse：拒绝文件工具误用 viking:// URI
│   ├── capture.mjs              # Stop/PreCompact hook：跨平台入队→分离启动 uploader
│   ├── capture.ps1              # 旧版 Windows PowerShell hook（保留给历史安装排障）
│   ├── uploader.mjs             # 游标增量解析 transcript→提取文本→OV 会话 API
│   ├── ov-doctor.mjs            # 10 项自诊断（含技能 REST 接口检查）
│   └── lib/
│       ├── ov-common.mjs        # hook 共享：配置链 + workspace peer + fetchJSON
│       └── profile-inject.mjs   # 官方共享层 vendored（上游整文件覆盖同步）
└── com.github.copilot/
    └── hooks/hooks.json         # 五事件（SessionStart/UserPromptSubmit/PreToolUse/PreCompact/Stop）

install.ps1                      # 组员安装器（拷贝+凭据+VS Code settings 合并）
.github/plugin/marketplace.json  # 插件市场清单（本仓库即市场）
docs/                            # 文档（安装/使用/排障/本文）
```

## 设计要点

- **hook 快 / uploader 慢分离**：hook <1s 只追加队列；上传分离进程（hooks 要求 <5s）。插件 hook 命令统一为 `node "${PLUGIN_ROOT}/scripts/hook-runner.mjs" <event>`：`${PLUGIN_ROOT}` 由 Copilot 宿主在命令串展开并注入环境变量（CLI 与 VS Code 均支持），绝对路径同时兼容 CLI（cwd=插件目录）与 VS Code（cwd=工作区）两种执行环境；runner 负责补齐 `PLUGIN_ROOT` 并转发到真实脚本，仍避免 PowerShell 依赖与 Windows 反斜杠问题。超时字段必须是 `timeoutSec`——Copilot CLI 对含未知字段（如 `timeout`）的 hook 条目会整体静默丢弃
- **幂等**：字节偏移游标（`state\<session_id>.json`）+ OV 会话 ID `import__copilot__<id>`；重跑/崩溃/双启动不重不漏
- **提取策略**对齐官方 ingest：user/assistant 文本保留，tool I/O 丢弃，peer_id 取 `copilot/<model>` 与工作区 peer
- **workspace peer 推导**（官方 ovcli 工作区配置同语义）：`.openviking/config.json` 的 `peer.id` > 归一化 git origin > 仓库根；非 git 目录不发 peer
- **本地 MCP 工具**：服务端 MCP 面刻意不暴露的写路径/任务面由 `localToolProvider` 扩展点补齐——`add_skill` / `update_skill` / `validate_skill`（REST `/api/v1/skills*`，`path` 参数走 temp_upload 上传本地 SKILL.md）与 `task_status`（`GET /api/v1/tasks/{id}`）。`tools/list` 时拼在服务端 15 个工具后，`tools/call` 时本地拦截；凭据/身份头与代理共用同一解析链。代码放 `local-tools/` 而非 `servers/`——后者上游同步时整目录覆盖，本地修改会静默丢失
- **召回带 session_id**（官方接入约定①）：auto-recall 转发 `import__copilot__<id>`（与捕获管线同一 OV 会话），激活服务端跨轮去重台账。注意：去重收益来自 session_id，与 query_expansion 是独立开关——鉴于实测团队服务器 expansion/rerank 在长查询下超 15s、且检索路径存在间歇性 12s+ 抖动，auto-recall 默认发送短查询（≤400 字符）并显式关闭 expansion/rewrite；命中慢请求时 fetch 20s 超时后该轮静默跳过，绝不阻塞 prompt
- **profile 注入**（SessionStart）：vendored 官方 `profile-inject.mjs`（profile.md + preferences/entities 清单，6000 token CJK 感知预算）；离线/未配置静默跳过，绝不阻塞会话启动
- **uri-guard**（PreToolUse）：文件工具收到 `viking://` 路径 → deny 并提示改用 openviking MCP 工具；terminal 命令含 `viking://` → 放行 + systemMessage 提示；openviking MCP 工具自身放行。VS Code 忽略 matcher，过滤在脚本内做
- **PreCompact 归档**：压缩前触发捕获管线（上传增量 + commit keep 0），长会话压缩不丢未归档上下文；官方 CC 同语义（PreCompact 只 commit）
- **上游同步注意**：`local-tools/mcp-entry.mjs` 的 `readProxyConfig` 与 `servers/mcp-proxy.mjs` 是同一凭据链的复制（外加 `restBaseUrl` 字段）；上游改 `buildProxyConnection`/`buildMcpProxyConfig` 签名时两处都要改，`plugin.test.mjs` 有断言防漂移。`scripts/lib/profile-inject.mjs` 整文件 vendored，同步 = 覆盖 + 保留两行头部注释
- 官方上游同步：`servers/` 与 `skills/` 来自 volcengine/OpenViking `agent-plugins/`，升级时整目录覆盖

## 与官方 Claude Code 插件的对照

本插件功能对标官方 `examples/claude-code-memory-plugin`（Auto-Recall/Auto-Capture/Pending Queue/Doctor），差异点：

| 能力 | 官方 CC 插件 | 本插件 |
|---|---|---|
| 自动召回 | UserPromptSubmit → additionalContext | 同机制 + 转发 session_id（激活服务端扩写/去重） |
| profile 注入 | SessionStart（10000 token） | SessionStart（6000 token，vendored 官方 profile-inject） |
| 自动捕获 | Stop + PreCompact + SessionEnd | Stop + PreCompact（capture.mjs 双事件门） |
| uri-guard | PreToolUse 拒绝/提示 | 同语义（PreToolUse deny + systemMessage；VS Code 忽略 matcher，脚本内过滤） |
| 离线队列 | pending 目录 + 重试预算/TTL | queue.jsonl + 下次 Stop 重试（简化实现） |
| 写 skill | ❌（MCP `write` 可写域不含 `skills/`，与所有 MCP 型 harness 一致） | ✅ 本地工具 add_skill / update_skill / validate_skill 走 REST，支持 `path` 上传本地 SKILL.md（v0.4.0） |
| 后台任务查询 | ❌（MCP 面无 task 工具） | ✅ task_status（GET /api/v1/tasks/{id}，`ov task status` 等价） |
| 自诊断 | ov-memory-doctor skill + 脚本 | ov-doctor.mjs（10 项，含技能 REST 接口检查） |

未移植（有意）：SubagentStart/SubagentStop（Copilot 转录文件的子代理结构未验证）、压缩接管 takeover（VS Code 自管压缩，无接管面）、statusline（VS Code 无插件 statusline）、召回再摘要客户端压缩（服务端 context 面 max_tokens 已控注入预算，本地注入块限 8 条）。

**勘误**：本文早期版本称"PreCompact 无对应事件"——错误。VS Code 插件 hooks 与工作区 hooks 支持相同的 8 个生命周期事件（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PreCompact / SubagentStart / SubagentStop / Stop），v0.4.0 起本插件接入其中 5 个。



## transcript 格式风险

`events.jsonl` 是 Copilot 内部结构（1.0.81-0 / gpt-5.5 实测），非稳定 API。VS Code/Copilot 升级后若捕获异常，先用 `--dry-run` 对一个新会话跑一遍看解析是否正常：

```powershell
node <插件目录>\scripts\uploader.mjs --session <会话id> --dry-run
```

## 回归验证链（改动后照此走）

1. `node --check` 全部 .mjs；历史 PowerShell 脚本可用 PSParser 额外检查
2. `node plugin/plugin.test.mjs`（规范 7 项）
3. dry-run 对真实 transcript（auto-recall / uploader 各一次）
4. 真传 + 服务端 `GET .../context` 比对消息数/顺序/peer_id
5. 幂等回归：重跑 uploader 应 `no new events`
6. ov-doctor 全绿
7. 端到端：模拟 Stop 事件进 capture.mjs → 队列入队 → 分离 uploader 清空队列

## 管理员操作

### 签发 user key

```bash
curl -X POST <your-openviking-server-url>/api/v1/admin/accounts/<your-account-id>/users \
  -H "X-API-Key: <admin-key>" -H "Content-Type: application/json" \
  -d '{"user_id": "<组员名>"}'
```

返回的 `user_key` 按团队惯例私发（桌面临时 txt / 即时消息单发），不进任何仓库。

### 发版流程

1. 改代码 → 走回归验证链
2. `plugin/plugin.json` bump version；`.github/plugin/marketplace.json` 同步 version（**CI 会校验两者一致，不一致直接红**）
3. commit + push（master）—— push 触发 GitHub Actions `plugin-gate`：脚本语法 / 规范测试 / JSON 合法性 / 版本一致性 / 敏感扫描，全绿才算发版成功
4. 通知组员按升级流程操作（installation.md 末节）

CI 失败时不要让组员拉取——Actions 页（仓库 → Actions 标签）看红叉原因，修复合并后再发通知。
