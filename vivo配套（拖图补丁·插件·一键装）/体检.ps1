# vivo 截图那一套体检：pwsh -File 体检.ps1 —— 一条条报每样东西在不在、对不对，只看不改
# 有 ❌ 就跑同夹 换电脑一键装.ps1 补上（它已经装好的会跳过）；退出码 = ❌ 的条数
# -HomeDir 换个家目录（自测用）
param([string]$HomeDir = $env:USERPROFILE)
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$here = $PSScriptRoot
$store = if ($env:VIVO拖图补丁备份) { $env:VIVO拖图补丁备份 } else { "D:\Downloads\vivo办公套件\拖图补丁备份" }
$transit = if ($env:VIVO中转夹) { $env:VIVO中转夹 } else { "D:\Downloads\vivo办公套件\截图中转" }
$hook = "E:\个人AI资源管理\60_公用资源（钩子·skill·搜索引擎·可后期扩展）\70_钩子（让AI到点自动干活的机关·多agent共用）\脚本\拖图-vivo截图换成文件.cjs"
$bad = 0
function Report([bool]$Ok, [string]$Text, [string]$Fix = "") {
  if ($Ok) { Write-Host "✅ $Text" } else { Write-Host "❌ $Text$(if ($Fix) { "  → $Fix" })"; $script:bad++ }
}
function Same([string]$A, [string]$B) {
  (Test-Path -LiteralPath $A) -and (Test-Path -LiteralPath $B) -and (Get-FileHash -LiteralPath $A).Hash -eq (Get-FileHash -LiteralPath $B).Hash
}

Write-Host "== vivo 和拖图补丁"
$patch = (& node (Join-Path $here "拖图补丁\打补丁.cjs") --看) 2>&1
Report ($LASTEXITCODE -eq 0) "vivo 拖图补丁：$patch" "双击 拖图补丁\双击装补丁.cmd"
$backups = @(Get-ChildItem -LiteralPath (Join-Path $store "原版备份") -File -ErrorAction SilentlyContinue)
Report ($backups.Count -gt 0) "原版备份：$($backups.Count) 份（$store\原版备份）" "装补丁时会自动备份；没备份就退不回原版"

Write-Host "== 桌宠的 vivo 截图复制（点「复制」后 Ctrl+V 能贴）"
$pet = @(Get-CimInstance Win32_Process -Filter "name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*多Agent桌面宠物*" })
Report ($pet.Count -gt 0) "桌宠在跑" "打开桌宠（入口 F:\程序\0016_多Agent桌面宠物\入口）"
$log = Get-ChildItem (Join-Path $env:LOCALAPPDATA "我的App日志\多Agent桌面宠物") -Filter "vivo-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$ready = $log -and (Select-String -LiteralPath $log.FullName -Pattern "vivo 截图复制就绪" -Quiet)
Report $ready "vivo 截图复制板块起来过$(if ($log) { "（日志 $($log.Name)）" })" "重开桌宠；还不行看桌宠日志 vivo-*.log"
Report (Test-Path -LiteralPath $transit) "中转夹在：$transit" "点一次复制会自己建"

Write-Host "== Claude Code"
$modSrc = Join-Path $here "Claude Code插件\vivo-drag-image"
$modDst = Join-Path $HomeDir ".claude\mods\vivo-drag-image"
$modOk = $true
foreach ($f in @(Get-ChildItem -LiteralPath $modSrc -Recurse -File)) {
  if (-not (Same $f.FullName (Join-Path $modDst $f.FullName.Substring($modSrc.Length + 1)))) { $modOk = $false }
}
Report $modOk "拖图插件装着、跟项目里那份一样（$modDst）" "跑 换电脑一键装.ps1"
Report (Test-Path -LiteralPath $hook) "兜底钩子脚本在" "E 盘资源库没恢复？"
$cc = (& node (Join-Path $here "Claude Code插件\接设置.cjs") --看 --settings (Join-Path $HomeDir ".claude\settings.json") --mod $modDst --hook $hook) 2>&1
$ccOk = $LASTEXITCODE -eq 0
$cc | ForEach-Object { Write-Host $_ }
if (-not $ccOk) { $bad++; Write-Host "   → 跑 换电脑一键装.ps1" }

Write-Host "== Pi"
Report (Same (Join-Path $here "Pi插件\vivo-drag.ts") (Join-Path $HomeDir ".pi\agent\extensions\vivo-drag.ts")) "Pi 插件装着、跟项目里那份一样" "跑 换电脑一键装.ps1，再在 Pi 窗口里 /reload"

Write-Host ""
if ($bad) { Write-Host "有 $bad 处不对，照上面箭头修" } else { Write-Host "全部正常" }
exit $bad
