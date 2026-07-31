<#
Run the full installer smoke test interactively (PowerShell)

What it does:
  1) Runs preflight
  2) Runs detect --insecure
  3) Runs confirm (uses detected candidate)
  4) Runs register-and-record (runs local registration and records output)
  After each stage the script pauses so you can inspect output or files (installer-state.json).

Usage (from project root):
  powershell -ExecutionPolicy Bypass -File .\scripts\run-installer-smoke.ps1

Notes:
- If PowerShell execution is restricted, the -ExecutionPolicy Bypass flag in the command above will allow the script to run for this invocation only.
- The script will try to open installer-state.json in VS Code (code) if available, otherwise it falls back to Notepad.
- Use --base-url with the confirm step by editing the script if you want to force a specific URL.
#>

$ErrorActionPreference = 'Stop'

function RunStep {
  param($description, $command)
  Write-Host "=== $description ===" -ForegroundColor Cyan
  Write-Host "Running: $command`n"
  & cmd /c $command
  $exit = $LASTEXITCODE
  Write-Host "`nExit code: $exit" -ForegroundColor Yellow
  Write-Host "Pausing — press Enter to continue or Ctrl+C to abort."
  Read-Host | Out-Null
  return $exit
}

$root = (Get-Location).Path
$stateFile = Join-Path $root 'installer-state.json'

# 1) Preflight
RunStep "Preflight checks" "node cli\installer\installer.js preflight"

# 2) Detect (use --insecure for local self-signed certs)
RunStep "Detect (probes)" "node cli\installer\installer.js detect --insecure"

# Helpful: open installer-state.json now for inspection
if (Get-Command code -ErrorAction SilentlyContinue) {
  Write-Host "Opening installer-state.json in VS Code..." -ForegroundColor Green
  code $stateFile
} else {
  Write-Host "Opening installer-state.json in Notepad..." -ForegroundColor Green
  Start-Process notepad $stateFile
}
Write-Host "Inspect the file and press Enter to continue..."
Read-Host | Out-Null

# 3) Confirm — uses detected candidate in installer-state.json
RunStep "Confirm selected base URL" "node cli\installer\installer.js confirm"

# 4) Register & record (runs local registration and writes results)
Write-Host "Note: this step executes the local registration script (scripts/register-panel.cjs)." -ForegroundColor Magenta
RunStep "Register and record" "node cli\installer/register-and-record.js"

# Final: open the state file for final inspection
if (Get-Command code -ErrorAction SilentlyContinue) {
  Write-Host "Opening installer-state.json in VS Code for final inspection..." -ForegroundColor Green
  code $stateFile
} else {
  Write-Host "Opening installer-state.json in Notepad for final inspection..." -ForegroundColor Green
  Start-Process notepad $stateFile
}

Write-Host "`nSmoke test finished. Review installer-state.json for results (xui.probesResults, xui.confirmed, xui.registration, etc.)." -ForegroundColor Cyan
Write-Host "If you want a Unix/bash variant for WSL or macOS, tell me and I'll add it." -ForegroundColor Cyan