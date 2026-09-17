# copilot-ov-capture

OpenViking 记忆平台 × GitHub Copilot（VS Code）集成：**一个插件包同时提供**

1. **召回 + 手动沉淀**（标准 Agent Plugins 1.0）：openviking MCP 工具集（find/search/read/remember...）+ openviking-memory 技能——Copilot 会话中可检索团队记忆库、显式沉淀经验
2. **自动捕获**（`com.github.copilot/` 扩展）：Stop hook 自动把 Copilot 会话内容（用户输入 + 模型回复）回放到 OpenViking，commit 触发记忆提取——不依赖模型"记得去记"

> 前置：团队 OpenViking 服务（内网），由管理员（chenjie）为每人签发 user key。

---

## 一、组员安装（一次，约 5 分钟）

两条安装路径，选其一：

### 路径 A：Copilot CLI 市场安装（推荐，标准分发方式）

本仓库自身就是一个插件市场（`.github/plugin/marketplace.json`）：

```bash
# 1. 注册市场（一行）
copilot plugin marketplace add radial-hks/copilot-ov-capture
# 2. 安装插件（一行；已装过时此命令即升级）
copilot plugin install openviking-copilot@openviking-team
# 3. 验证加载
copilot plugin list
```

> **缓存陷阱（官方文档明示）**：CLI 安装后从缓存读取，改动插件源目录后必须**重新执行 install** 才生效。升级流程 = `git pull` 后重跑第 2 步。
>
> 此路径装好的是 **Copilot CLI** 侧的技能/MCP/hooks；VS Code 侧的插件注册（`chat.pluginLocations`）仍需跑一次 install.ps1 或手工在用户级 settings.json 加两条配置（见路径 B 第 3 步说明）。

### 路径 B：install.ps1（Windows 全自动，VS Code + Copilot CLI 通用）

- **插件包**：`git clone` 本仓库（或 zip 解压）到任意目录，如 `D:\tools\copilot-ov-capture`
- **你的 user key**：找管理员开通（私发，形式为一串 token）

```powershell
cd <仓库目录>
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <你的user-key>
```

安装器做三件事（幂等，可重复运行）：
- 拷贝插件到 `%USERPROFILE%\.openviking\copilot-ov-plugin`
- 写凭据 `%USERPROFILE%\.openviking\ovcli.conf`（`url` + `api_key`；MCP 代理与捕获上传器共用，**不进任何 git 仓库**）
- 合并 VS Code **用户级** settings.json：`chat.plugins.enabled: true` + `chat.pluginLocations` 指向插件目录（自动探测真实 user-data 目录，含自定义 `--user-data-dir` 场景）

> 注意：**两条路径都需要凭据**。即使走路径 A，也要先写好 `ovcli.conf`（直接手工创建，或跑一次 install.ps1 只为写凭据和 VS Code 注册）。

### 验证（两条命令）

```powershell
# 一键自诊断：Node/凭据/连通/鉴权/peer/捕获管线/VS Code 注册 9 项检查
node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\ov-doctor.mjs
```

应全绿（`VS Code 插件注册` 一项需先完成下面第 4 步）。然后：

1. VS Code：`Ctrl+Shift+P` → **Developer: Reload Window**
2. Copilot Chat（Agent 模式）问：`列出你的 MCP 工具，并用 openviking 的 health 检查服务状态`
   - ✅ 预期：报告 openviking server healthy
3. **自动召回验证**（核心新功能）：在新会话问一个和团队历史工作相关的问题，如"eidcolorcontrol 当时怎么做的"——Copilot 会自动带上相关记忆上下文（`Developer: Show Agent Debug Logs` 可看到 `<openviking-context>` 注入）
4. 自动捕获验证：随便问一个实质问题，会话结束后：
   ```powershell
   Get-Content %USERPROFILE%\.openviking\copilot-capture\uploader.log -Tail 5
   ```
   - ✅ 预期：出现 `session <id>: +N messages, committed`
5. Studio：浏览器打开 `http://10.67.8.199:1933/studio`，用**自己的 user key** 登录，Sessions 页应能看到 `import__copilot__<会话id>`

### 4. 更新插件

```powershell
cd <仓库目录> && git pull
# 路径 A 用户：重装即升级（缓存陷阱——不重装不生效）
copilot plugin install openviking-copilot@openviking-team
# 路径 B 用户：重新运行 install.ps1（会覆盖插件目录，凭据与 settings 合并保留）
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <你的user-key>
```

---

## 二、日常使用

### 自动召回（新，核心体验）

**每条 prompt 发出前自动执行**：插件从团队记忆库检索相关经验（按当前仓库的 peer 定向），把最相关的条目注入为 `<openviking-context>` 上下文块——Copilot 无需调用任何工具就能"记得"团队之前踩过的坑、做过的方案。

- 检索限定工作区 peer + 阈值过滤，只注入强相关内容（弱相关命中自动丢弃）
- 服务器不可达时静默跳过，**绝不阻塞你的提问**
- 问历史相关问题时，Copilot 的回答会自然带上团队经验（不用再手动"搜一下 openviking"）

### 其他日常

- **会话自动捕获**：会话结束后 Stop hook 自动触发，记忆提取由服务端异步完成（1-2 分钟）
- **手动检索**：Copilot 里说"用 openviking 搜一下 XXX"（openviking MCP 工具）
- **显式沉淀**：会话中随时说"把这个经验 remember 到 openviking"——适合你想确保入库的结论
- **Studio**：`http://10.67.8.199:1933/studio`，user key 登录，可看/搜自己的全部记忆与会话

### 出问题怎么办（自诊断）

```powershell
node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\ov-doctor.mjs
```

9 项体检（Node / 凭据 / 连通 / 鉴权 / peer / 队列 / 游标 / 上传日志 / VS Code 注册），FAIL 项自带修复提示。先把 doctor 结果发给管理员，而不是截图聊天窗口。

### 按项目精准召回（workspace peer）

捕获管线会从会话所在目录推导**工作区 peer**（与官方 ovcli 工作区配置同语义），项目经验自动归拢到 `peers/<peer_id>/` 下，实现按代码仓库隔离的记忆：

- **有 origin 的仓库**：无需任何配置。peer 取归一化的 origin URL（如 `github.com-org-repo`），同一仓库的所有 clone、所有协作者机器推导出同一个 peer，项目记忆自动聚合
- **想自定义**：仓库根建 `.openviking/config.json` 提交进 git，全团队生效：
  ```json
  {"version": 1, "peer": {"id": "my-project"}}
  ```
- **非 git 目录 / 临时目录**：不发 peer，记忆进用户级空间（避免为每个临时目录铸造空 peer）
- 凭据类键（url/api_key）写进工作区配置会被剥离——服务器地址永远只看 ovcli.conf

**MCP 召回侧**（Copilot 对话中调 openviking 工具）默认是全量召回（其他 peer 命中自动降分垫底）。如需严格的项目隔离召回，把 `ovcli.conf` 加 `actor_peer_id` 字段（对整个用户生效）或按会话设 `OPENVIKING_PEER_ID` 环境变量。工作区级 `recall.peer_scope` 精细控制在 MCP 代理路线暂不可用（代理是长驻进程，无法按工作区切换），这是官方已知边界。

### 数据去向（隐私边界）

| 内容 | 上传时机 |
|---|---|
| 你发给 Copilot 的每条消息 | 会话结束（Stop）自动 |
| 模型的文本回复（final answer） | 同上 |
| 工具调用的输入/输出 | **不上传**（低价值，按官方 ingest 策略丢弃） |
| 与 OpenViking 无关的 VS Code 操作 | **不上传**（hook 只在 Copilot 会话生命周期触发） |

数据归属：account `unreal-dev`，user 你本人；assistant peer 为 `copilot/<模型名>`，user peer 取你仓库的 git email。

---

## 三、排障速查

| 症状 | 处理 |
|---|---|
| Copilot 说没有 openviking MCP 工具 | 检查用户级 settings.json 的 `chat.plugins.enabled` 和 `chat.pluginLocations`；确认 Reload Window 过；`Developer: Show Agent Debug Logs` 搜 plugin |
| health 报错/连接失败 | `curl http://10.67.8.199:1933/health`；确认内网/VPN 通；检查 `ovcli.conf` 的 key 是否完整（401 = key 错） |
| uploader.log 报 UPLOAD FAILED | 服务器暂不可达，队列保留在 `queue.jsonl`，下次会话结束自动重试；也可手动 `node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\uploader.mjs` |
| 会话没被捕获 | 看 `events-mirror.jsonl` 是否有 Stop 事件（无 = hook 没触发，查 hooks.json 是否在 Reload 后加载）；有 = 看 uploader.log |
| 想重传/回填历史会话 | `node <插件目录>\scripts\uploader.mjs --backfill --dry-run` 先预览，去掉 `--dry-run` 执行（注意：commit 触发 LLM 提取，量大分批） |
| 中文乱码 | 已修复（UTF-8 显式编解码）；旧版本捕获的乱码数据仅影响调试镜像，不影响上传 |

---

## 四、架构（维护者参考）

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
```

### 与官方 Claude Code 插件的对照

本插件功能对标官方 `examples/claude-code-memory-plugin`（Auto-Recall/Auto-Capture/Pending Queue/Doctor），差异点：

| 能力 | 官方 CC 插件 | 本插件 |
|---|---|---|
| 自动召回 | UserPromptSubmit → additionalContext | 同机制（VS Code hooks 同名字段） |
| 自动捕获 | Stop + PreCompact + SessionEnd | Stop（Copilot 转录文件即会话终态，PreCompact 无对应事件） |
| 离线队列 | pending 目录 + 重试预算/TTL | queue.jsonl + 下次 Stop 重试（简化实现） |
| 自诊断 | ov-memory-doctor skill + 脚本 | ov-doctor.mjs（9 项） |
| 部署形态 | Claude marketplace | Agent Plugins 1.0 + install.ps1 |

- **hook 快 / uploader 慢分离**：hook <1s 只追加队列；上传分离进程（hooks 要求 <5s）
- **幂等**：字节偏移游标（`state\<session_id>.json`）+ OV 会话 ID `import__copilot__<id>`；重跑/崩溃/双启动不重不漏
- **提取策略**对齐官方 ingest：user/assistant 文本保留，tool I/O 丢弃，peer_id 取 `copilot/<model>` 与工作区 peer
- 官方上游同步：`servers/` 与 `skills/` 来自 volcengine/OpenViking `agent-plugins/`，升级时整目录覆盖

### transcript 格式风险

`events.jsonl` 是 Copilot 内部结构（1.0.81-0 / gpt-5.5 实测），非稳定 API。VS Code/Copilot 升级后若捕获异常，先用 `--dry-run` 对一个新会话跑一遍看解析是否正常。

### 管理员：签发 user key

```bash
curl -X POST http://10.67.8.199:1933/api/v1/admin/accounts/unreal-dev/users \
  -H "X-API-Key: <admin-key>" -H "Content-Type: application/json" \
  -d '{"user_id": "<组员名>"}'
```
