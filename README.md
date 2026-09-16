# copilot-ov-capture

GitHub Copilot (VS Code) 会话自动捕获 → OpenViking 记忆管线。

## 架构

```
VS Code Copilot 会话结束
  └─ Stop hook (src/capture.ps1, <1s)
       ├─ 读 stdin 事件 JSON（UTF-8 显式解码）
       ├─ {session_id, transcript_path, cwd} 追加到
       │    %USERPROFILE%\.openviking\copilot-capture\queue.jsonl
       └─ Start-Process 分离启动 uploader（不阻塞 agent）
            └─ src/uploader.mjs (Node ≥18, 零依赖)
                 ├─ 按 session 去重队列
                 ├─ 字节偏移游标增量读 events.jsonl
                 │    （state\<session_id>.json，断点续传/幂等）
                 ├─ 提取 user/assistant 文本（tool I/O 丢弃，
                 │    对齐 openviking ingest 的 normalize 策略）
                 └─ ensure_session → batch append(≤100) → commit
                      会话ID: import__copilot__<session_id>
                      peer_id: copilot/<model> (assistant)
```

## 关键设计

- **hook 快、uploader 慢分离**：hook 只做追加（毫秒级），上传由分离进程做，
  不阻塞 agent（hooks 要求 <5s）
- **幂等**：游标只消费完整行；重跑/崩溃/双启动都不重不漏（上游 ingest replay 同款思路）
- **降级安全**：服务器不可达时队列保留，下次 Stop 事件再触发 uploader 重试
- **提取策略**：只保留 user.message.content 与 assistant.message 的
  final_answer（含 chunk 合并；无 final_answer 的 turn 退化用 commentary），
  工具调用细节按 ingest 规范视为低价值丢弃

## 凭据

与 ov CLI / agent-plugins 代理同源：`OPENVIKING_URL`/`OPENVIKING_API_KEY` 环境变量
→ `%USERPROFILE%\.openviking\ovcli.conf`（本机实际为 wanglinfeng 配置文件）。

## 用法

```powershell
# 手动传一个会话
node src\uploader.mjs --session <session_id> [--transcript-dir <dir>]

# 解析不传（调试）
node src\uploader.mjs --session <session_id> --dry-run

# 回填全部历史会话（注意：commit 触发 LLM 提取，量大时分批）
node src\uploader.mjs --backfill [--dry-run]
```

队列与状态目录：`%USERPROFILE%\.openviking\copilot-capture\`
（queue.jsonl / state\ / uploader.log / events-mirror.jsonl / uploader-*.out|err）

## 已知边界

- transcript 格式（events.jsonl）是 Copilot 内部结构，非稳定 API，随版本漂移需回归
- 提取的记忆量取决于对话实质内容；寒暄类会话 commit 后 0 记忆属正常
- wanglinfeng 目录错位（USERPROFILE 历史遗留）不影响功能，凭据与
  session-state 都从该路径解析
