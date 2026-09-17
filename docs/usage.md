# 日常使用指南

> 本文从 README 分拆，面向已安装完成的团队成员。安装见 [installation.md](installation.md)，排障见 [troubleshooting.md](troubleshooting.md)。

## 自动召回（核心体验）

**每条 prompt 发出前自动执行**：插件从团队记忆库检索相关经验（按当前仓库的 peer 定向），把最相关的条目注入为 `<openviking-context>` 上下文块——Copilot 无需调用任何工具就能"记得"团队之前踩过的坑、做过的方案。

- 检索限定工作区 peer + 阈值过滤，只注入强相关内容（弱相关命中自动丢弃）
- 检索携带会话 ID（与捕获管线同一 OV 会话）：同一会话内已注入过的记忆不重复注入（服务端跨轮去重），且服务端按会话上下文扩写检索词
- 服务器不可达时静默跳过，**绝不阻塞你的提问**
- 问历史相关问题时，Copilot 的回答会自然带上团队经验（不用再手动"搜一下 openviking"）

## 开场注入（SessionStart）

每个新会话的第一条 prompt 时注入一次：你的个人档案（profile.md，含职位/偏好/在用工具）+ 可用的偏好/实体记忆清单。Copilot 从第一句话起就"认识你"，不用每次自我介绍。约 6000 token 预算，CJK 内容按实际密度计算；未配置凭据或服务器不可达时静默跳过。

## 上下文保护（自动，无需操作）

- **压缩前归档（PreCompact）**：长会话触发 VS Code 上下文压缩前，先把未归档的对话增量上传并 commit——压缩只影响本地上下文窗口，OpenViking 侧不丢任何未提取内容
- **viking:// URI 防护（PreToolUse）**：Copilot 误把 `viking://` 资源当本地文件去读/写时，调用被拒绝并提示改用 openviking MCP 工具（read/list/find）——不再出现"文件不存在"的困惑报错

## 其他日常

- **会话自动捕获**：会话结束后 Stop hook 自动触发，记忆提取由服务端异步完成（1-2 分钟）
- **手动检索**：Copilot 里说"用 openviking 搜一下 XXX"（openviking MCP 工具）
- **显式沉淀**：会话中随时说"把这个经验 remember 到 openviking"——适合你想确保入库的结论
- **写入/更新技能**：说"把这个流程存成一个 skill"——Copilot 调 `add_skill` 把 SKILL.md 写入你的个人技能目录（`viking://~/skills`；也支持 `path` 直接上传本地 SKILL.md 文件）；`update_skill` 整包替换、`validate_skill` 先校验。add/commit 是异步的，返回的 task_id 可用 `task_status` 查询进度。注意：通用 `write` 工具写不了 skills（服务端设计边界，见排障表）
- **Studio**：`<your-openviking-server-url>/studio`，user key 登录，可看/搜自己的全部记忆与会话

## 出问题怎么办（自诊断）

```powershell
node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\ov-doctor.mjs
```

```bash
node ~/.openviking/copilot-ov-plugin/scripts/ov-doctor.mjs
```

10 项体检（Node / 凭据 / 连通 / 鉴权 / 技能接口 / peer / 队列 / 游标 / 上传日志 / VS Code 注册），FAIL 项自带修复提示。先把 doctor 结果发给管理员，而不是截图聊天窗口。

## 按项目精准召回（workspace peer）

捕获管线会从会话所在目录推导**工作区 peer**（与官方 ovcli 工作区配置同语义），项目经验自动归拢到 `peers/<peer_id>/` 下，实现按代码仓库隔离的记忆：

- **有 origin 的仓库**：无需任何配置。peer 取归一化的 origin URL（如 `github.com-org-repo`），同一仓库的所有 clone、所有协作者机器推导出同一个 peer，项目记忆自动聚合
- **想自定义**：仓库根建 `.openviking/config.json` 提交进 git，全团队生效：
  ```json
  {"version": 1, "peer": {"id": "my-project"}}
  ```
- **非 git 目录 / 临时目录**：不发 peer，记忆进用户级空间（避免为每个临时目录铸造空 peer）
- 凭据类键（url/api_key）写进工作区配置会被剥离——服务器地址永远只看 ovcli.conf
- **UE 工程多插件**（同一 git 仓库装多个插件）：默认共享工程级 peer（插件间经验互通）；需要插件级隔离时在该插件目录放独立 `.openviking/config.json` 写自己的 `peer.id`

**MCP 召回侧**（Copilot 对话中调 openviking 工具）默认是全量召回（其他 peer 命中自动降分垫底）。如需严格的项目隔离召回，把 `ovcli.conf` 加 `actor_peer_id` 字段（对整个用户生效）或按会话设 `OPENVIKING_PEER_ID` 环境变量。工作区级 `recall.peer_scope` 精细控制在 MCP 代理路线暂不可用（代理是长驻进程，无法按工作区切换），这是官方已知边界。

## 数据去向（隐私边界）

| 内容 | 上传时机 |
|---|---|
| 你发给 Copilot 的每条消息 | 会话结束（Stop）自动 |
| 模型的文本回复（final answer） | 同上 |
| 工具调用的输入/输出 | **不上传**（低价值，按官方 ingest 策略丢弃） |
| 与 OpenViking 无关的 VS Code 操作 | **不上传**（hook 只在 Copilot 会话生命周期触发） |

数据归属：account（团队内部约定），user 你本人；assistant peer 为 `copilot/<模型名>`，user peer 取工作区 peer（或 git email）。
