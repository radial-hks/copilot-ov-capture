# copilot-ov-capture

OpenViking 记忆平台 × GitHub Copilot（VS Code + Copilot CLI）集成插件，**一个包同时提供**：

1. **召回 + 手动沉淀**（标准 Agent Plugins 1.0）：openviking MCP 工具集（find/search/read/remember...）+ openviking-memory 技能
2. **自动召回注入**（v0.3.0+）：每条 prompt 前自动检索团队记忆并注入上下文——Copilot 无需调工具就"记得"团队经验
3. **自动捕获**（`com.github.copilot/` 扩展）：Stop hook 自动把会话内容（用户输入 + 模型回复）回放到 OpenViking，commit 触发记忆提取
4. **能力面补全**（v0.4.0）：技能写入工具（`add_skill` / `update_skill` / `validate_skill`，本地 SKILL.md `path` 上传也支持）+ `task_status` 后台任务查询 + SessionStart 开场 profile 注入 + PreCompact 压缩前归档 + PreToolUse `viking://` URI 防护 + 召回携带 session_id（对齐官方约定，激活服务端扩写与跨轮去重）

> **让 Copilot 帮你装**：把本仓库地址发给你的 Copilot 助手，加一句"读 llms.txt 帮我安装"——它会按仓库根的 [llms.txt](llms.txt) 流程引导完成（只在 user key 环节需要你提供管理员私发的凭据）。

> 前置：团队 OpenViking 服务（内网），由团队管理员为每人签发 user key。

## 快速开始（组员）

```jsonc
// VS Code 用户级 settings.json 加一行（仓库市场原生支持，私有仓库亦可）
"chat.plugins.marketplaces": ["radial-hks/copilot-ov-capture"]
// 然后 Extensions 面板搜 @agentPlugins → Install openviking-copilot
```

凭据（一次性）：手工创建 `%USERPROFILE%\.openviking\ovcli.conf`（`url` + `api_key`），或跑 install.ps1 代写。详见 [docs/installation.md](docs/installation.md)（三条路径）。

装完自检：`node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\ov-doctor.mjs`

## 文档

| 文档 | 内容 | 读者 |
|---|---|---|
| [docs/installation.md](docs/installation.md) | 三条安装路径（VS Code 市场 / CLI 市场 / install.ps1）、验证清单、升级流程 | 首次安装的组员 |
| [docs/usage.md](docs/usage.md) | 自动召回/自动捕获日常使用、workspace peer、隐私边界 | 全体使用者 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 症状→处理速查表 | 全体使用者 |
| [docs/architecture.md](docs/architecture.md) | 架构、官方插件对照、回归链、管理员操作（开 key / 发版） | 维护者 |

## 支持的环境

- VS Code ≥ 1.102（Agent plugins + hooks 支持）；Copilot 插件策略未被组织禁用
- Node ≥ 18（stdio 代理与上传器共用）
- Windows（install.ps1 / capture.ps1 为 PowerShell）；Linux/macOS 走市场安装路径可用（hooks 需自行适配 shell 命令）

## 版本

- 0.4.1 — 自动召回保守化：查询截短 400 字符 + `query_expansion`/`rewrite` 显式关闭（实测团队服务器的 expansion/rerank 在长查询下超 15s；session_id 去重收益不受影响，检索路径仍有间歇性 12s+ 抖动，hook 静默降级兜底）
- 0.4.0 — 能力面补全：本地技能工具（add/update/validate_skill + `path` 上传）+ task_status + SessionStart profile 注入 + PreCompact 归档 + uri-guard + 召回带 session_id + ov-doctor 技能接口检查
- 0.3.0 — auto-recall 注入 + ov-doctor 自诊断 + marketplace 分发
- 0.2.0 — workspace peer 推导（按仓库精准召回）
- 0.1.0 — 首版：MCP + skill + Stop 捕获管线
