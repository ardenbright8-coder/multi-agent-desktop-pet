$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  多Agent桌面宠物 · 在这套系统上登记（两套系统共用 F 盘）" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$sharedData = "F:\应用数据\AgentPetHub"
if (Test-Path -LiteralPath $sharedData) {
  [Environment]::SetEnvironmentVariable("AGENT_PET_HUB_HOME", $sharedData, "User")
  $env:AGENT_PET_HUB_HOME = $sharedData
  Write-Host "[1/3] 已登记用户环境变量 AGENT_PET_HUB_HOME -> $sharedData" -ForegroundColor Green
}

& (Join-Path $PSScriptRoot "install-autostart.ps1")
Write-Host "[2/3] 已登记开机自启快捷方式 -> 入口\多Agent桌面宠物.exe" -ForegroundColor Green

$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$env:ELECTRON_RUN_AS_NODE = "1"
foreach ($s in @("install-claude-code.mjs", "install-pi.mjs", "install-opencode.mjs", "install-grok.mjs")) {
  $p = Join-Path $PSScriptRoot $s
  if (Test-Path -LiteralPath $p) {
    & $electron $p 2>&1 | ForEach-Object { Write-Host "  $_" }
  }
}
Write-Host "[3/3] 已补齐本系统 Claude / Pi / OpenCode / Grok 的桌宠钩子与桥接文件" -ForegroundColor Green
