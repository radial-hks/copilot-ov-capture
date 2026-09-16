# copilot-ov-capture

OpenViking 记忆平台 × GitHub Copilot（VS Code）集成：**一个插件包同时提供**

1. **召回 + 手动沉淀**（标准 Agent Plugins 1.0）：openviking MCP 工具集（find/search/read/remember...）+ openviking-memory 技能——Copilot 会话中可检索团队记忆库、显式沉淀经验
2. **自动捕获**（`com.github.copilot/` 扩展）：Stop hook 自动把 Copilot 会话内容（用户输入 + 模型回复）回放到 OpenViking，commit 触发记忆提取——不依赖模型"记得去记"

> 前置：团队 OpenViking 服务（内网），由管理员（chenjie）为每人签发 user key。

---

## 一、组员安装（一次，约 5 分钟）

### 1. 拿到两样东西

- **插件包**：`git clone` 本仓库（或 zip 解压）到任意目录，如 `D:\tools\copilot-ov-capture`
- **你的 user key**：找管理员开通（私发，形式为一串 token）

### 2. 运行安装器（PowerShell）

```powershell
cd <仓库目录>
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <你的user-key>
```

安装器做三件事（幂等，可重复运行）：
- 拷贝插件到 `%USERPROFILE%\.openviking\copilot-ov-plugin`
- 写凭据 `%USERPROFILE%\.openviking\ovcli.conf`（`url` + `api_key`；MCP 代理与捕获上传器共用，**不进任何 git 仓库**）
- 合并 VS Code **用户级** settings.json：`chat.plugins.enabled: true` + `chat.pluginLocations` 指向插件目录（自动探测真实 user-data 目录，含自定义 `--user-data-dir` 场景）

### 3. 验证

1. VS Code：`Ctrl+Shift+P` → **Developer: Reload Window**
2. Copilot Chat（Agent 模式）问：`列出你的 MCP 工具，并用 openviking 的 health 检查服务状态`
   - ✅ 预期：报告 openviking server healthy
3. 语义召回测试：`用 openviking 的 search 工具搜"eidcolorcontrol"相关经验`
   - ✅ 预期：返回团队库中该定制功能的案例
4. 自动捕获测试：随便问一个实质问题（如"帮我看下这段代码"），会话结束后查看：
   ```powershell
   Get-Content %USERPROFILE%\.openviking\copilot-capture\uploader.log -Tail 5
   ```
   - ✅ 预期：出现 `session <id>: +N messages, committed`
5. Studio：浏览器打开 `http://10.67.8.199:1933/studio`，用**自己的 user key** 登录，Sessions 页应能看到 `import__copilot__<会话id>`

### 4. 更新插件

```powershell
cd <仓库目录> && git pull
# 重新运行 install.ps1（会覆盖插件目录，凭据与 settings 合并保留）
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <你的user-key>
```

---

## 二、日常使用

- **什么都不用做**：会话结束后 Stop hook 自动触发捕获，记忆提取由服务端异步完成（1-2 分钟）
- **检索**：Copilot 里直接说"用 openviking 搜一下 XXX 的经验"（或依赖 openviking-memory 技能自动触发）
- **显式沉淀**：会话中随时说"把这个经验 remember 到 openviking"——适合你想确保入库的结论
- **Studio**：`http://10.67.8.199:1933/studio`，user key 登录，可看/搜自己的全部记忆与会话

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
│   ├── capture.ps1              # Stop hook：UTF-8 读事件→入队→分离启动 uploader
│   └── uploader.mjs             # 游标增量解析 transcript→提取文本→OV 会话 API
└── com.github.copilot/
    └── hooks/hooks.json         # ${PLUGIN_ROOT} 引用 capture.ps1（无硬编码路径）

install.ps1                      # 组员安装器（拷贝+凭据+VS Code settings 合并）
```

- **hook 快 / uploader 慢分离**：hook <1s 只追加队列；上传分离进程（hooks 要求 <5s）
- **幂等**：字节偏移游标（`state\<session_id>.json`）+ OV 会话 ID `import__copilot__<id>`；重跑/崩溃/双启动不重不漏
- **提取策略**对齐官方 ingest：user/assistant 文本保留，tool I/O 丢弃，peer_id 取 `copilot/<model>` 与 git email
- 官方上游同步：`servers/` 与 `skills/` 来自 volcengine/OpenViking `agent-plugins/`，升级时整目录覆盖

### transcript 格式风险

`events.jsonl` 是 Copilot 内部结构（1.0.81-0 / gpt-5.5 实测），非稳定 API。VS Code/Copilot 升级后若捕获异常，先用 `--dry-run` 对一个新会话跑一遍看解析是否正常。

### 管理员：签发 user key

```bash
curl -X POST http://10.67.8.199:1933/api/v1/admin/accounts/unreal-dev/users \
  -H "X-API-Key: <admin-key>" -H "Content-Type: application/json" \
  -d '{"user_id": "<组员名>"}'
```
