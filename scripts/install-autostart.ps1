param(
  [string]$Version = "0.1.1"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot "release-$Version\win-unpacked"
$executables = @(Get-ChildItem -LiteralPath $releaseDir -Filter "*.exe" -File)
if ($executables.Count -ne 1) {
  throw "Expected exactly one executable in: $releaseDir"
}
$target = $executables[0].FullName
$startup = [Environment]::GetFolderPath("Startup")
$productName = -join @([char]0x591A, "Agent", [char]0x684C, [char]0x9762, [char]0x5BA0, [char]0x7269)
$shortcutPath = Join-Path $startup "$productName.lnk"

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "Desktop pet executable was not found: $target"
}
if (-not (Test-Path -LiteralPath $startup -PathType Container)) {
  throw "Windows Startup folder was not found: $startup"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = "--skip-integration-install"
$shortcut.WorkingDirectory = Split-Path -Parent $target
$shortcut.Description = "Multi-agent desktop pet: start at login and stay in the tray"
$shortcut.Save()

$saved = $shell.CreateShortcut($shortcutPath)
if ($saved.TargetPath -ne $target -or $saved.Arguments -ne "--skip-integration-install") {
  throw "Autostart shortcut verification failed"
}

Write-Output "AUTOSTART_OK $shortcutPath"
