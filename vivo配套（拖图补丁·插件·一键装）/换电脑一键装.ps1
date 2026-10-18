# vivo 截图那一套，换电脑或坏了以后一键装回：pwsh -File 换电脑一键装.ps1
# 前提：E 盘资源库已经在（钩子脚本、本项目都在里面）、vivo 办公套件已装、node 和 pwsh 能用、桌宠已装（vivo 截图复制本来就在桌宠里，随桌宠走）
# 装四样，每样已经装好的就跳过，可以反复跑：
#   1. vivo 拖图补丁（会弹一次管理员确认；已装就跳过）
#   2. Claude Code 拖图插件 → ~\.claude\mods\vivo-drag-image，settings.json 接上插件和兜底钩子（改前备份）
#   3. Pi 插件 vivo-drag.ts → ~\.pi\agent\extensions\（Pi 窗口里 /reload 才生效）
#   4. 跑一遍体检
# -HomeDir 换个家目录（自测用，不碰真设置）；-SkipVivo 不装 vivo 补丁
param([string]$HomeDir = $env:USERPROFILE, [switch]$SkipVivo)
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$hook = "E:\个人AI资源管理\60_公用资源（钩子·skill·搜索引擎·可后期扩展）\70_钩子（让AI到点自动干活的机关·多agent共用）\脚本\拖图-vivo截图换成文件.cjs"
$ccBackup = "E:\个人AI资源管理\20_环境运维配置（管这台机·服务器·软件设置）\Claude Code（配置与手感调优）\_old"
if ($HomeDir -ne $env:USERPROFILE) { $ccBackup = Join-Path $HomeDir "_备份" }

function Copy-IfChanged([string]$From, [string]$To) {
  New-Item -ItemType Directory -Force -Path (Split-Path $To) | Out-Null
  if ((Test-Path -LiteralPath $To) -and (Get-FileHash -LiteralPath $To).Hash -eq (Get-FileHash -LiteralPath $From).Hash) { return $false }
  Copy-Item -LiteralPath $From -Destination $To -Force
  return $true
}

Write-Host "== 1. vivo 拖图补丁"
if ($SkipVivo) { Write-Host "跳过（-SkipVivo）" }
else {
  & pwsh -NoProfile -File (Join-Path $here "拖图补丁\装补丁.ps1")
  if ($LASTEXITCODE -ne 0) { Write-Host "❌ vivo 补丁没装上，接着装别的" }
}

Write-Host "== 2. Claude Code 拖图插件"
$modSrc = Join-Path $here "Claude Code插件\vivo-drag-image"
$modDst = Join-Path $HomeDir ".claude\mods\vivo-drag-image"
$n = 0
foreach ($f in @(Get-ChildItem -LiteralPath $modSrc -Recurse -File)) {
  if (Copy-IfChanged $f.FullName (Join-Path $modDst $f.FullName.Substring($modSrc.Length + 1))) { $n++ }
}
Write-Host "插件文件：更新了 $n 个 → $modDst"
if (-not (Test-Path -LiteralPath $hook)) { Write-Host "❌ 钩子脚本不在：$hook（E 盘资源库没恢复？）" }
& node (Join-Path $here "Claude Code插件\接设置.cjs") --settings (Join-Path $HomeDir ".claude\settings.json") --mod $modDst --hook $hook --backup $ccBackup

Write-Host "== 3. Pi 插件"
$piDst = Join-Path $HomeDir ".pi\agent\extensions\vivo-drag.ts"
if (Copy-IfChanged (Join-Path $here "Pi插件\vivo-drag.ts") $piDst) { Write-Host "装好了 → $piDst（Pi 窗口里 /reload）" } else { Write-Host "早就是最新的，没动" }

Write-Host "== 4. 体检"
& pwsh -NoProfile -File (Join-Path $here "体检.ps1") -HomeDir $HomeDir
