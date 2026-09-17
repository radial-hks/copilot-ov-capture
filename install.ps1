# install.ps1 — OpenViking Copilot plugin installer (one command for team members).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey <your-user-key> [-ServerUrl <your-openviking-server-url>]
#
# What it does (idempotent, safe to re-run):
#   1. Copies this repo's plugin/ to %USERPROFILE%\.openviking\copilot-ov-plugin
#   2. Writes %USERPROFILE%\.openviking\ovcli.conf (URL + user key) — shared by the
#      MCP proxy and the capture uploader; never touches git repos
#   3. Merges chat.plugins.enabled + chat.pluginLocations into the VS Code USER
#      settings.json (auto-detects the real user-data dir, including custom
#      --user-data-dir scenarios)
#   4. Prints verification steps.

param(
    [Parameter(Mandatory = $true)]
    [string]$ApiKey,
    [string]$ServerUrl = "<your-openviking-server-url>"
)

$ErrorActionPreference = "Stop"

# --- locate the real VS Code user settings.json -----------------------------
function Get-CodeUserSettings {
    # VS Code may run with a custom --user-data-dir; scan running processes for it.
    $dataDir = $null
    try {
        $procs = Get-CimInstance Win32_Process -Filter "name='Code.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -match '--user-data-dir="?([^"\s]+)"?') {
                $dataDir = $Matches[1]; break
            }
        }
    } catch { }
    if (-not $dataDir) { $dataDir = Join-Path $env:APPDATA "Code" }
    $settings = Join-Path $dataDir "User\settings.json"
    return @{ DataDir = $dataDir; Settings = $settings }
}

$here = Split-Path -Parent $PSCommandPath
$pluginSrc = Join-Path $here "plugin"
if (-not (Test-Path (Join-Path $pluginSrc "plugin.json"))) {
    throw "plugin/ not found next to install.ps1 — run this script from the repo root."
}

# --- 1. copy plugin ----------------------------------------------------------
$dst = Join-Path $env:USERPROFILE ".openviking\copilot-ov-plugin"
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
Copy-Item -Recurse -Force $pluginSrc $dst
Write-Host "[1/3] plugin copied to: $dst"

# --- 2. credentials -----------------------------------------------------------
$ovDir = Join-Path $env:USERPROFILE ".openviking"
if (-not (Test-Path $ovDir)) { New-Item -ItemType Directory -Path $ovDir -Force | Out-Null }
$confPath = Join-Path $ovDir "ovcli.conf"
$conf = @{ url = $ServerUrl; api_key = $ApiKey } | ConvertTo-Json
[System.IO.File]::WriteAllText($confPath, $conf, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[2/3] credentials written: $confPath (ov CLI compatible; also used by MCP proxy + capture uploader)"

# --- 3. VS Code user settings ---------------------------------------------------
$code = Get-CodeUserSettings
$settingsDir = Split-Path -Parent $code.Settings
if (-not (Test-Path $settingsDir)) {
    throw "VS Code user settings directory not found at $($code.Settings). Open VS Code once, then re-run."
}
if (-not (Test-Path $code.Settings)) {
    New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
    [System.IO.File]::WriteAllText($code.Settings, "{}", (New-Object System.Text.UTF8Encoding($false)))
}
$raw = [System.IO.File]::ReadAllText($code.Settings)
try { $settings = $raw | ConvertFrom-Json } catch { throw "Cannot parse existing settings.json — fix it manually first." }

# merge our keys (add members, or overwrite existing values)
function Set-Prop($obj, [string]$name, $value) {
    if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
    else { $obj | Add-Member -MemberType NoteProperty -Name $name -Value $value }
}
Set-Prop $settings "chat.plugins.enabled" $true
$loc = @{}
if ($settings.PSObject.Properties["chat.pluginLocations"] -and $settings."chat.pluginLocations") {
    $loc = $settings."chat.pluginLocations"
}
# remove stale entries pointing at our dst, then set the fresh one
$clean = @{}
foreach ($p in $loc.PSObject.Properties) { if ($p.Value -is [bool]) { $clean[$p.Name] = $p.Value } }
$clean[$dst] = $true
Set-Prop $settings "chat.pluginLocations" $clean

$out = $settings | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($code.Settings, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[3/3] VS Code user settings updated: $($code.Settings)"

Write-Host ""
Write-Host "Install complete. Next:"
Write-Host "  1. In VS Code: Ctrl+Shift+P -> 'Developer: Reload Window'"
Write-Host "  2. In Copilot Chat (Agent mode) ask: 'list your MCP tools and check openviking health'"
Write-Host "     -> should report the openviking server healthy"
Write-Host "  3. Studio: $ServerUrl/studio (log in with your user key)"
Write-Host "  4. After any Copilot session ends, check the capture log:"
Write-Host "     %USERPROFILE%\.openviking\copilot-capture\uploader.log"
