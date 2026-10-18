# pwsh -File 退回原版.ps1：把 vivo 程序包换回最近一次备份的原版（补丁出问题时用）
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$ErrorActionPreference = "Stop"
$store = if ($env:VIVO拖图补丁备份) { $env:VIVO拖图补丁备份 } else { "D:\Downloads\vivo办公套件\拖图补丁备份" }
$latest = Get-ChildItem -LiteralPath (Join-Path $store "原版备份") -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latest) { throw "原版备份夹里没有备份：$store\原版备份" }
Write-Host "换回：$($latest.FullName)"
& pwsh -NoProfile -File (Join-Path $PSScriptRoot "换程序包.ps1") -From $latest.FullName -LogDir (Join-Path $store "日志")
