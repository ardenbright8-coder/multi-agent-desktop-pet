# 给 vivo 办公套件装上「拖图交原图」补丁（双击同夹 双击装补丁.cmd 跑的就是这个）
# vivo 升级后补丁会被盖掉，再跑一遍就行：它会先备份新版原件，再做补丁换上去
# 大文件（原版备份 300 多兆、做出来的补丁包）放 D 盘备份夹，不进 E 盘存档
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$src = "C:\Program Files (x86)\pcsuite\resources\app.asar"
$store = if ($env:VIVO拖图补丁备份) { $env:VIVO拖图补丁备份 } else { "D:\Downloads\vivo办公套件\拖图补丁备份" }
$backupDir = Join-Path $store "原版备份"
$patched = Join-Path $store "app.asar.改好的"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
if (-not (Test-Path -LiteralPath $src)) { throw "没找到 vivo 办公套件（$src），先装 vivo" }

& node (Join-Path $here "打补丁.cjs") --看 $src | Out-Null
$state = $LASTEXITCODE
if ($state -eq 0) { Write-Host "vivo 现在就是装了最新补丁的，不用再装"; exit 0 }

if ($state -eq 3) {
  # 装的是旧版补丁：补丁只能拿原版来打，从备份里找同一个 vivo 版本的原版（2026-10-24 补丁升 v2 时加的）
  $ver = (& node (Join-Path $here "打补丁.cjs") --版本 $src | Select-Object -Last 1)
  $original = Get-ChildItem -LiteralPath $backupDir -Filter "app.asar.原版-*" | Sort-Object LastWriteTime -Descending |
    Where-Object { (& node (Join-Path $here "打补丁.cjs") --版本 $_.FullName | Select-Object -Last 1) -eq $ver } | Select-Object -First 1
  if (-not $original) { throw "vivo 装的是旧版补丁，但备份夹里没有 $ver 版的原版（$backupDir）。先跑 退回原版.ps1 或重装 vivo，再双击装补丁；vivo 没动" }
  Write-Host "vivo 装的是旧版补丁，拿原版备份重打：$($original.Name)（vivo $ver）"
  & node (Join-Path $here "打补丁.cjs") $original.FullName $patched
  if ($LASTEXITCODE -ne 0) { throw "补丁没做出来，vivo 没动" }
} else {
  & node (Join-Path $here "打补丁.cjs") $src $patched
  if ($LASTEXITCODE -ne 0) { throw "补丁没做出来（多半是 vivo 升级改了代码，要重新看代码改补丁），vivo 没动" }

  $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
  $backup = Join-Path $backupDir ("app.asar.原版-" + (Get-Item -LiteralPath $src).LastWriteTime.ToString("yyyyMMdd") + "-" + $hash.Substring(0, 8))
  if (-not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $src -Destination $backup
    if ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $hash) { throw "备份核对不上，vivo 没动" }
  }
  Write-Host "原版已备份：$backup"
}

& pwsh -NoProfile -File (Join-Path $here "换程序包.ps1") -From $patched -LogDir (Join-Path $store "日志")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
