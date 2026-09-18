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

> **缓存陷阱（官方文档明示）**：CLI 安装后从缓存读取，改动插件源目录后必须**重新执行 install** 才生效。升级流程 = 新版本发布后重跑 `copilot plugin install openviking-copilot@openviking-team`。
>
> CLI 装的插件（`~/.copilot/installed-plugins/`）VS Code 会**自动发现**，两边共用——无需重复安装。

**装完插件本体后，还差凭据**（MCP/捕获上传器需要）：

```powershell
# 手工创建 %USERPROFILE%\.openviking\ovcli.conf，内容：
{ "url": "<your-openviking-server-url>", "api_key": "<你的user-key>" }
```

或跑一次 install.ps1 只为写凭据（`-ApiKey` 参数）。

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

**装完插件本体后，还差凭据**（MCP/捕获上传器需要）：

```powershell
# 手工创建 %USERPROFILE%\.openviking\ovcli.conf，内容：
{ "url": "<your-openviking-server-url>", "api_key": "<你的user-key>" }
```

或跑一次 install.ps1 只为写凭据（`-ApiKey` 参数）。

### 路径 3：install.ps1（Windows 全自动一键装，适合不想碰 settings.json 的组员）

- **插件包**：`git clone` 本仓库（或 zip 解压）到任意目录，如 `D:\tools\copilot-ov-capture`
- **你的 user key**：找管理员开通

```powershell
cd <仓库目录>
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <你的user-key> -ServerUrl <你的-openviking-server-url>
```

Windows 安装器做三件事（幂等，可重复运行）：
- 拷贝插件到 `%USERPROFILE%\.openviking\copilot-ov-plugin`
- 写凭据 `%USERPROFILE%\.openviking\ovcli.conf`（`url` + `api_key`；MCP 代理与捕获上传器共用，**不进任何 git 仓库**）
- 合并 VS Code **用户级** settings.json：`chat.plugins.enabled: true` + `chat.pluginLocations` 指向插件目录（自动探测真实 user-data 目录，含自定义 `--user-data-dir` 场景）

> 三条路径都需要凭据。路径 1/2 装完插件本体后，务必补 `ovcli.conf`（见路径 1 末尾）。

## 安装后验证（两条命令）

```powershell
# Windows：一键自诊断（Node/凭据/连通/鉴权/peer/捕获管线/VS Code 注册等）
node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\ov-doctor.mjs
```

```bash
# Linux/macOS：市场安装后按实际插件目录运行 doctor
node ~/.openviking/copilot-ov-plugin/scripts/ov-doctor.mjs
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
   - ✅ 预期：出现 `session <id>: +N messages, committed`
5. Studio：浏览器打开 `<your-openviking-server-url>/studio`，用**自己的 user key** 登录，Sessions 页应能看到 `import__copilot__<会话id>`

## 更新插件

```powershell
cd <仓库目录> && git pull
# 路径 1 用户：重装即升级（缓存陷阱——不重装不生效）
copilot plugin install openviking-copilot@openviking-team
# 路径 2 用户：界面自动检查（24h 周期）；手动触发用 Ctrl+Shift+P → Extensions: Check for Extension Updates，有新版点 Update
# 路径 3 用户：重新运行 install.ps1（会覆盖插件目录，凭据与 settings 合并保留）
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <你的user-key> -ServerUrl <你的-openviking-server-url>
```
