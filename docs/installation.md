# 组员安装指南

> 本文从 README 分拆，面向**首次安装**的团队成员。日常使用见 [usage.md](usage.md)，排障见 [troubleshooting.md](troubleshooting.md)。

前置：团队 OpenViking 服务（内网），由团队管理员为每人签发 user key（私发，一串 token）。

## 安装路径，按推荐顺序

### 路径 1：Copilot CLI 市场安装（推荐，核心路径）

团队后续核心安装方式对齐官方 marketplace 体验：如果团队环境已经预注册 `openviking-team` 市场，直接安装插件即可。

```bash
copilot plugin install openviking-copilot@openviking-team
```

如果 Copilot CLI 版本较旧，或当前机器尚未注册内部市场并提示 marketplace unknown，先注册一次，再安装：

```bash
copilot plugin marketplace add radial-hks/copilot-ov-capture
copilot plugin install openviking-copilot@openviking-team
```

验证加载：

```bash
copilot plugin list
```

> **缓存陷阱（官方文档明示）**：CLI 安装后从缓存读取，改动插件源目录不会自动生效。升级流程 = 新版本发布后优先运行 `copilot plugin update openviking-copilot@openviking-team`；update 不可用或失败时再重跑 `copilot plugin install openviking-copilot@openviking-team`。
>
> CLI 装的插件（`~/.copilot/installed-plugins/`）VS Code 会**自动发现**，无需重复安装。
>
> **两套目录是预期行为**：CLI 会把运行时插件放在 `~/.copilot/installed-plugins/<marketplace>/<plugin>/`，并在 `~/.copilot/Library/Caches/copilot/marketplaces/` 缓存市场仓库；VS Code 图形市场会把仓库缓存到 `~/.vscode/agent-plugins/github.com/<owner>/<repo>/plugin`。同时用过 CLI 安装和 VS Code 图形安装时，看到两份 `openviking-copilot` 目录不是冲突。若两边版本不同，以 `copilot plugin list`、两个目录的 `plugin.json` 为准，优先运行 `copilot plugin update openviking-copilot@openviking-team` 刷新 CLI 侧，再在 VS Code 执行 `Developer: Reload Window`。

**装完插件本体后，还差凭据**（MCP/捕获上传器需要）。手工创建 `%USERPROFILE%\.openviking\ovcli.conf`：

```powershell
{ "url": "<your-openviking-server-url>", "api_key": "<你的user-key>" }
```

> 记事本另存为 UTF-8 无 BOM（Node 的 `JSON.parse` 对 BOM 敏感）；该文件含个人凭据，**不进任何 git 仓库**。

### 路径 2：VS Code 图形安装（补充路径）

VS Code 原生支持仓库市场——settings.json 加一行，之后全程图形界面：

```jsonc
// 用户级 settings.json（Ctrl+Shift+P → Preferences: Open User Settings (JSON)）
"chat.plugins.marketplaces": ["radial-hks/copilot-ov-capture"]
```

然后：
1. 打开 Extensions 面板（`Ctrl+Shift+X`）→ 搜索框输入 `@agentPlugins`
2. 在列表中找到 **openviking-copilot** → 点 Install（首次会弹出市场信任确认）
3. 升级自动：VS Code 每 24 小时检查更新（`Extensions: Check for Extension Updates` 可手动触发），有新版本时界面出现 Update 按钮

> 私有仓库同样支持：公开查找失败时 VS Code 会回退直接 clone（需本机 GitHub 凭据）。本仓库当前为公开。

**装完插件本体后，同样需要凭据**（见路径 1 末尾的 `ovcli.conf` 格式）。

## 安装后验证

```powershell
# Windows：一键自诊断（Node/凭据/连通/鉴权/技能接口/peer/捕获队列/捕获游标/最近上传/插件注册/Hook 命令路径/配置项）
node "<插件目录>\scripts\ov-doctor.mjs"
# CLI 安装的插件目录通常在：
node "%USERPROFILE%\.copilot\installed-plugins\openviking-team\openviking-copilot\scripts\ov-doctor.mjs"
```

```bash
# Linux/macOS：市场安装后按实际插件目录运行 doctor
node ~/.copilot/installed-plugins/openviking-team/openviking-copilot/scripts/ov-doctor.mjs
```

应全绿。然后：

1. VS Code：`Ctrl+Shift+P` → **Developer: Reload Window**
2. Copilot Chat（Agent 模式）问：`列出你的 MCP 工具，并用 openviking 的 health 检查服务状态`
   - ✅ 预期：报告 openviking server healthy
3. **自动召回验证**（核心功能）：在新会话问一个和团队历史工作相关的问题，如"帮我回顾之前做过的类似功能"——Copilot 会自动带上相关记忆上下文（`Developer: Show Agent Debug Logs` 可看到 `<openviking-context>` 注入）
4. 自动捕获验证：随便问一个实质问题，会话结束后：
   ```powershell
   Get-Content %USERPROFILE%\.openviking\copilot-capture\uploader.log -Tail 5
   ```
   ```bash
   tail -n 5 ~/.openviking/copilot-capture/uploader.log
   ```
   - ✅ 预期：出现 `session <id>: +N messages, pending (below commit threshold)` 或 `session <id>: +N messages, committed`；短会话 pending 是 v0.5.0 起的默认策略，PreCompact 或手动 `--commit` 会强制归档
5. Studio：浏览器打开 `<your-openviking-server-url>/studio`，用**自己的 user key** 登录，Sessions 页应能看到 `import__copilot__<会话id>`

## 更新插件

```bash
# 路径 1（CLI 安装）：update 即升级（CLI 有缓存陷阱——不更新不生效）
copilot plugin update openviking-copilot@openviking-team
```

`copilot plugin update` 不可用或失败时，再重跑 `copilot plugin install openviking-copilot@openviking-team`。

```text
路径 2（VS Code 市场）：界面自动检查（24h 周期）；手动触发用 Ctrl+Shift+P → Extensions: Check for Extension Updates，有新版点 Update
```

## v0.5.0 升级后重点

- `copilot plugin install openviking-copilot@openviking-team` 后建议立刻跑 `ov-doctor`，确认 **配置项** 与 **Hook 命令路径** 都 PASS。
- 普通短会话可能只上传 pending，不马上抽取记忆；需要立刻归档时运行 `node <插件目录>/scripts/uploader.mjs --session <会话id> --commit`。
- 管理员发布前可运行 `node <插件目录>/scripts/e2e-live.mjs`，用真实 OpenViking 服务验证上传、commit 与清理链路。
