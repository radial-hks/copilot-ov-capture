# OpenViking x Copilot capture hook (Stop event) — plugin edition.
# Paths resolved via the PLUGIN_ROOT environment variable that VS Code sets
# for hook processes (no hardcoded user directories).
#
# Fast path (< 1s): read event JSON from stdin as UTF-8, append
# {session_id, transcript_path, cwd} to the capture queue, then launch the
# uploader DETACHED. The uploader drains the queue idempotently (per-session
# byte-offset cursors), so double-launches, crashes and offline servers lose
# nothing.

$ErrorActionPreference = "Stop"

# --- read stdin as raw bytes, decode UTF-8 ([Console]::In would decode with
# --- the legacy ANSI codepage and corrupt non-ASCII prompts)
$stdin = [Console]::OpenStandardInput()
$ms = New-Object System.IO.MemoryStream
$buf = New-Object byte[] 65536
while (($n = $stdin.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
$in = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())

try { $ev = $in | ConvertFrom-Json } catch { exit 0 }
# Stop: session end (terminal state). PreCompact: VS Code is about to compact
# the conversation — archive + commit the transcript delta first (official
# Claude Code plugin does commit-only at PreCompact; same semantics here).
if ($ev.hook_event_name -ne "Stop" -and $ev.hook_event_name -ne "PreCompact") { exit 0 }

$sessionId = $ev.session_id
if (-not $sessionId) { exit 0 }

$transcript = $ev.transcript_path
$cwd = $ev.cwd
$ts = $ev.timestamp

$baseDir = Join-Path $env:USERPROFILE ".openviking\copilot-capture"
if (-not (Test-Path $baseDir)) { New-Item -ItemType Directory -Path $baseDir -Force | Out-Null }

$queueFile = Join-Path $baseDir "queue.jsonl"
$entry = @{
    session_id      = $sessionId
    transcript_path = $transcript
    cwd             = $cwd
    timestamp       = $ts
} | ConvertTo-Json -Compress
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::AppendAllText($queueFile, $entry + "`n", $utf8)

# Debug mirror of raw hook events (bounded by manual cleanup).
$mirror = Join-Path $baseDir "events-mirror.jsonl"
[System.IO.File]::AppendAllText($mirror, $in + "`n", $utf8)

# --- launch uploader detached. Double-launches are harmless: per-session
# --- cursors make uploads idempotent.
$pluginRoot = $env:PLUGIN_ROOT
if (-not $pluginRoot) { $pluginRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) }
$uploader = Join-Path $pluginRoot "scripts\uploader.mjs"
if (Test-Path $uploader) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Start-Process -FilePath "node" -ArgumentList "`"$uploader`"" `
        -WindowStyle Hidden `
        -RedirectStandardError (Join-Path $baseDir "uploader-$stamp.err") `
        -RedirectStandardOutput (Join-Path $baseDir "uploader-$stamp.out")
}
