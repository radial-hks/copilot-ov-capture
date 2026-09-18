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
| [docs/installation.md](docs/installation.md) | 安装路径(Copilot CLI 市场 / VS Code 图形安装)、验证清单、升级流程 | 首次安装的组员 |
| [docs/usage.md](docs/usage.md) | 自动召回/自动捕获日常使用、workspace peer、隐私边界 | 全体使用者 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 症状→处理速查表 | 全体使用者 |
| [docs/architecture.md](docs/architecture.md) | 架构、官方插件对照、回归链、管理员操作(开 key / 发版) | 维护者 |
| [docs/changelog.md](docs/changelog.md) | 版本历史(完整根因记录,排障可按版本号检索) | 全体使用者 |

## 支持的环境

- VS Code ≥ 1.102（Agent plugins + hooks 支持）；Copilot 插件策略未被组织禁用
- Node ≥ 18（stdio 代理与上传器共用）
- Windows / Linux / macOS：五个 hook 命令与 MCP 入口均为 `node -e` 自定位引导（env `PLUGIN_ROOT` → cwd → CLI 安装路径兜底），不依赖宿主展开 `${PLUGIN_ROOT}` 或注入环境变量，PowerShell/bash/cmd 下均原样执行；Stop/PreCompact 捕获用 Node 实现，不依赖 PowerShell 脚本

## 版本

当前 **v0.4.12**。完整历史与每版根因记录见 [docs/changelog.md](docs/changelog.md)。

| 里程碑 | 内容 |
|---|---|
| 0.4.11–0.4.12 | 许可证（Apache-2.0）+ vendored 卫生；去私有化（installed-plugins 通用扫描）——为上游化铺路 |
| 0.4.5–0.4.10 | 双宿主稳定性：hooks/MCP 自定位引导、Windows 退出崩溃、VS Code transcript、timeoutSec |
| 0.4.0 | 能力面补全：skill 工具、task_status、profile 注入、PreCompact、uri-guard |
| 0.1–0.3 | 首版（MCP+捕获管线）、workspace peer、auto-recall + ov-doctor |
