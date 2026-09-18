# 排障速查

> 本文从 README 分拆。通用自诊断先跑 doctor（见 [usage.md](usage.md)），本文按症状查表。

| 症状 | 处理 |
|---|---|
| Copilot 说没有 openviking MCP 工具 | 检查用户级 settings.json 的 `chat.plugins.enabled` 和 `chat.pluginLocations`；确认 Reload Window 过；`Developer: Show Agent Debug Logs` 搜 plugin |
| write/edit 写 `viking://~/skills/...` 报只读/被拒 | **设计边界非故障**：服务端 MCP `write` 的可写域不含 `skills/`。用 `add_skill` 新建、`update_skill` 整包替换（Copilot 里直接说"存成 skill"即可）；doctor 的"技能 REST 接口"项 404 说明服务端版本过旧，找管理员升级 |
| health 报错/连接失败 | `curl <your-openviking-server-url>/health`；确认内网/VPN 通；检查 `ovcli.conf` 的 key 是否完整（401 = key 错） |
| uploader.log 报 UPLOAD FAILED | 服务器暂不可达，队列保留在 `queue.jsonl`，下次会话结束自动重试；也可手动 `node %USERPROFILE%\.openviking\copilot-ov-plugin\scripts\uploader.mjs`（Linux/macOS：`node ~/.openviking/copilot-ov-plugin/scripts/uploader.mjs`） |
| 会话没被捕获 | 看 `events-mirror.jsonl` 是否有 Stop 事件（无 = hook 没触发，查 hooks.json 是否在 Reload 后加载）；有 = 看 uploader.log |
| 想重传/回填历史会话 | `node <插件目录>\scripts\uploader.mjs --backfill --dry-run` 先预览，去掉 `--dry-run` 执行（注意：commit 触发 LLM 提取，量大分批） |
| add_skill/task_status 报任务 failed | `task_status` 带 `include_events: true` 看 execution_events 里的错误详情；常见：frontmatter 缺 name/description、name 超 64 字符或含非法字符（先跑 `validate_skill`）、目标 `viking://agent/skills` 无权限（默认个人根无需权限） |
| 中文乱码 | 已修复（UTF-8 显式编解码）；旧版本捕获的乱码数据仅影响调试镜像，不影响上传 |
| 改了插件源码没生效 | Copilot CLI 缓存陷阱：重新 `copilot plugin install openviking-copilot@openviking-team`；VS Code 侧市场安装用户 Reload Window 或检查插件更新，Windows 本地安装用户可重跑 install.ps1 |
