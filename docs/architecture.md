# 架构与维护指南

> 本文从 README 分拆，面向维护者（chenjie / 后续接手人）。组员文档见 [installation.md](installation.md) / [usage.md](usage.md) / [troubleshooting.md](troubleshooting.md)。

## 目录结构

```
plugin/                          # Agent Plugins 1.0 包（分发单元）
├── plugin.json                  # 清单（name: openviking-copilot）
├── mcp.json                     # stdio MCP 代理声明（官方上游）
├── servers/                     # 官方 mcp-proxy.mjs + shared（勿改，上游同步）
├── skills/                      # 官方 openviking-memory / ov-memory-troubleshoot（勿改）
├── scripts/
│   ├── auto-recall.mjs          # UserPromptSubmit：检索+注入 <openviking-context>
│   ├── capture.ps1              # Stop hook：UTF-8 读事件→入队→分离启动 uploader
│   ├── uploader.mjs             # 游标增量解析 transcript→提取文本→OV 会话 API
│   └── ov-doctor.mjs            # 9 项自诊断（对齐官方 ov-memory-doctor）
└── com.github.copilot/
    └── hooks/hooks.json         # ${PLUGIN_ROOT} 引用（无硬编码路径）

install.ps1                      # 组员安装器（拷贝+凭据+VS Code settings 合并）
.github/plugin/marketplace.json  # 插件市场清单（本仓库即市场）
docs/                            # 文档（安装/使用/排障/本文）
```

## 设计要点

- **hook 快 / uploader 慢分离**：hook <1s 只追加队列；上传分离进程（hooks 要求 <5s）
- **幂等**：字节偏移游标（`state\<session_id>.json`）+ OV 会话 ID `import__copilot__<id>`；重跑/崩溃/双启动不重不漏
- **提取策略**对齐官方 ingest：user/assistant 文本保留，tool I/O 丢弃，peer_id 取 `copilot/<model>` 与工作区 peer
- **workspace peer 推导**（官方 ovcli 工作区配置同语义）：`.openviking/config.json` 的 `peer.id` > 归一化 git origin > 仓库根；非 git 目录不发 peer
- 官方上游同步：`servers/` 与 `skills/` 来自 volcengine/OpenViking `agent-plugins/`，升级时整目录覆盖

## 与官方 Claude Code 插件的对照

本插件功能对标官方 `examples/claude-code-memory-plugin`（Auto-Recall/Auto-Capture/Pending Queue/Doctor），差异点：

| 能力 | 官方 CC 插件 | 本插件 |
|---|---|---|
| 自动召回 | UserPromptSubmit → additionalContext | 同机制（VS Code hooks 同名字段） |
| 自动捕获 | Stop + PreCompact + SessionEnd | Stop（Copilot 转录文件即会话终态，PreCompact 无对应事件） |
| 离线队列 | pending 目录 + 重试预算/TTL | queue.jsonl + 下次 Stop 重试（简化实现） |
| 自诊断 | ov-memory-doctor skill + 脚本 | ov-doctor.mjs（9 项） |
| 部署形态 | Claude marketplace | Agent Plugins 1.0 + marketplace.json + install.ps1 |

未移植（有意）：官方 SessionStart 的 profile 注入（Copilot 场景价值中等，skill 已覆盖大部分）、PreCompact 归档注入（VS Code 无对应事件）。

## transcript 格式风险

`events.jsonl` 是 Copilot 内部结构（1.0.81-0 / gpt-5.5 实测），非稳定 API。VS Code/Copilot 升级后若捕获异常，先用 `--dry-run` 对一个新会话跑一遍看解析是否正常：

```powershell
node <插件目录>\scripts\uploader.mjs --session <会话id> --dry-run
```

## 回归验证链（改动后照此走）

1. `node --check` 全部 .mjs；PowerShell PSParser 检查 .ps1
2. `node plugin/plugin.test.mjs`（规范 7 项）
3. dry-run 对真实 transcript（auto-recall / uploader 各一次）
4. 真传 + 服务端 `GET .../context` 比对消息数/顺序/peer_id
5. 幂等回归：重跑 uploader 应 `no new events`
6. ov-doctor 全绿
7. 端到端：模拟 Stop 事件进 capture.ps1 → 队列入队 → 分离 uploader 清空队列

## 管理员操作

### 签发 user key

```bash
curl -X POST http://10.67.8.199:1933/api/v1/admin/accounts/unreal-dev/users \
  -H "X-API-Key: <admin-key>" -H "Content-Type: application/json" \
  -d '{"user_id": "<组员名>"}'
```

返回的 `user_key` 按团队惯例私发（桌面临时 txt / 即时消息单发），不进任何仓库。

### 发版流程

1. 改代码 → 走回归验证链
2. `plugin/plugin.json` bump version；`.github/plugin/marketplace.json` 同步 version
3. commit + push（master）
4. 通知组员按升级流程操作（installation.md 末节）
