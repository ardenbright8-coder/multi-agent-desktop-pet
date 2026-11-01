# 把 vivo 的程序包 app.asar 换成指定的那份（装补丁、退回原版都走这里）
# 用法：pwsh -File 换程序包.ps1 -From <要换上去的 app.asar> [-LogDir <vivo 输出日志放哪>]
# 过程：关掉 vivo → 复制文件（vivo 还在 C 盘 Program Files 的才弹一次管理员确认）→ 核对 → 用普通身份重新打开 vivo
# 🚨 vivo 必须用普通身份打开：用管理员身份开的话，Windows 不让它往普通窗口里拖东西
param([Parameter(Mandatory)][string]$From, [string]$LogDir = "D:\Downloads\vivo办公套件\拖图补丁备份\日志")
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$ErrorActionPreference = "Stop"
$vivoDir = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\WOW6432Node\pcsuite' -ErrorAction SilentlyContinue).InstPath
if (-not $vivoDir) { $vivoDir = "C:\Program Files (x86)\pcsuite" }
$vivoDir = $vivoDir.TrimEnd('\')
$target = Join-Path $vivoDir "resources\app.asar"
$exe = Join-Path $vivoDir "pcsuite.exe"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $From)) { throw "找不到要换上去的文件：$From" }
$want = (Get-FileHash -LiteralPath $From -Algorithm SHA256).Hash
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $want) { Write-Host "已经是这份了，不用换"; exit 0 }

Write-Host "关掉 vivo 办公套件……"
Get-Process -Name pcsuite -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 20 -and (Get-Process -Name pcsuite -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
if (Get-Process -Name pcsuite -ErrorAction SilentlyContinue) { throw "vivo 关不掉，没换。重启电脑后再试" }

try {
  Copy-Item -LiteralPath $From -Destination $target -Force
} catch {
  Write-Host "复制程序包（会弹一次管理员确认，点「是」）……"
  $cmd = "Copy-Item -LiteralPath '$($From -replace "'","''")' -Destination '$($target -replace "'","''")' -Force"
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile", "-Command", $cmd
  if ($p.ExitCode -ne 0) { Write-Host "复制没成功（退出码 $($p.ExitCode)）" }
}

$ok = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $want
Write-Host "重新打开 vivo……"
Start-Process $exe -ArgumentList "--openAsHidden" `
  -RedirectStandardOutput (Join-Path $LogDir "vivo-out.log") -RedirectStandardError (Join-Path $LogDir "vivo-err.log")
if ($ok) { Write-Host "换好了" } else { throw "核对不上：程序包没换成，vivo 还是原来那份" }
