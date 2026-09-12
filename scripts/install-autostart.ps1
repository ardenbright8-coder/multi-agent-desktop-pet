# 开机自启指固定入口（跑源码），不许再指 release-0.1.xx 打包盒。
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$petRoot = Split-Path -Parent $projectRoot
$entryExe = Join-Path $petRoot "入口（开发版·跑源码）\多Agent桌面宠物.exe"
$startup = [Environment]::GetFolderPath("Startup")
$productName = -join @([char]0x591A, "Agent", [char]0x684C, [char]0x9762, [char]0x5BA0, [char]0x7269)
$shortcutPath = Join-Path $startup "$productName.lnk"

if (-not (Test-Path -LiteralPath $entryExe -PathType Leaf)) {
  throw "Fixed entry executable was not found: $entryExe"
}
if (-not (Test-Path -LiteralPath $startup -PathType Container)) {
  throw "Windows Startup folder was not found: $startup"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $entryExe
$shortcut.Arguments = ""
$shortcut.WorkingDirectory = Split-Path -Parent $entryExe
$shortcut.Description = "Multi-agent desktop pet: fixed source entry (boot and manual launch are the same)"
$shortcut.Save()

$saved = $shell.CreateShortcut($shortcutPath)
if ($saved.TargetPath -ne $entryExe) {
  throw "Autostart shortcut verification failed"
}

Write-Output "AUTOSTART_OK $shortcutPath -> $entryExe"
