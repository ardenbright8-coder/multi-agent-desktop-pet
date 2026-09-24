# 假的「AI 程序」：给 verify-bookmark-launch-paste.mjs 用。开一个命令窗口，记下收到了哪些字、有没有人按回车，
# 收完（字停了 2 秒）或等满 25 秒就把结果写进 $Out（JSON：text / enter）然后退出。
param([string]$Out)
$Host.UI.RawUI.WindowTitle = 'bookmark-fake-agent'
Write-Host '假 AI 程序：等看板贴字（别碰键盘）'
$buf = New-Object System.Text.StringBuilder
$enter = $false
$last = $null
$end = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $end) {
  while ([Console]::KeyAvailable) {
    $k = [Console]::ReadKey($true)
    if ($k.Key -eq 'Enter') { $enter = $true } else { [void]$buf.Append($k.KeyChar) }
    $last = Get-Date
  }
  if ($last -and ((Get-Date) - $last).TotalSeconds -gt 2) { break }
  Start-Sleep -Milliseconds 50
}
$json = @{ text = $buf.ToString(); enter = $enter } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding $false))
