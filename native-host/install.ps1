# Colophon native messaging host — Windows installer
# Run from the native-host\ directory:  .\install.ps1
# Requires Python 3.8+ in PATH.

param(
    [string]$ExtensionId = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ──────────────────────────────────────────────────────────────

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostScript = Join-Path $scriptDir "host.py"
$wrapperPath = Join-Path $scriptDir "host_wrapper.bat"
$manifestDest = Join-Path $scriptDir "com.colophon.llamahost.json"

if (-not (Test-Path $hostScript)) {
    Write-Error "host.py not found in $scriptDir"
    exit 1
}

# ── Verify Python is available ─────────────────────────────────────────────────

try {
    $pyVersion = & python --version 2>&1
    Write-Host "Found: $pyVersion"
} catch {
    Write-Error "Python not found in PATH. Install Python 3.8+ and re-run."
    exit 1
}

# ── Get extension ID ───────────────────────────────────────────────────────────

if (-not $ExtensionId) {
    Write-Host ""
    Write-Host "Open chrome://extensions, enable Developer mode, and copy your"
    Write-Host "Colophon extension ID (looks like: abcdefghijklmnopqrstuvwxyzabcdef)"
    Write-Host ""
    $ExtensionId = Read-Host "Paste extension ID"
}

$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -notmatch '^[a-z]{32}$') {
    Write-Warning "Extension ID looks unusual — expected 32 lowercase letters. Continuing anyway."
}

# ── Create bat wrapper (Chrome needs an executable, not a .py file) ───────────

$wrapperContent = "@echo off`r`npython `"%~dp0host.py`" %*`r`n"
[System.IO.File]::WriteAllText($wrapperPath, $wrapperContent, [System.Text.Encoding]::ASCII)
Write-Host "Created wrapper: $wrapperPath"

# ── Write manifest JSON ────────────────────────────────────────────────────────

$manifest = @{
    name            = "com.colophon.llamahost"
    description     = "Colophon llamafile host"
    path            = $wrapperPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3

[System.IO.File]::WriteAllText($manifestDest, $manifest, [System.Text.Encoding]::UTF8)
Write-Host "Wrote manifest: $manifestDest"

# ── Register in Windows registry (HKCU — no admin required) ───────────────────

$regKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.colophon.llamahost"
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name "(Default)" -Value $manifestDest
Write-Host "Registered in registry: $regKey"

Write-Host ""
Write-Host "Installation complete. Reload the Colophon extension in chrome://extensions."
