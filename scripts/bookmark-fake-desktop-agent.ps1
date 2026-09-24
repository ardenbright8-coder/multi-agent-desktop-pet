# 假的「桌面 AI 程序」（冒充 Codex、Hermes）：给 verify-bookmark-launch-paste.mjs 用。
# 验证脚本把 powershell.exe 复制一份改名 ChatGPT.exe（真 Codex 桌面版的程序名）再跑本脚本，看板就按程序名认出它。
# 开一个带输入框的小窗口，记下：有没有收到 Ctrl+N（新开对话）、Ctrl+N 之后输入框收到哪些字、有没有人按回车；
# 字停了 2 秒或等满 25 秒就把结果写进 $Out（JSON：ctrlN / text / enter / order）然后退出。
param([string]$Out)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'bookmark-fake-desktop-agent'
$form.Width = 520; $form.Height = 160; $form.KeyPreview = $true; $form.StartPosition = 'CenterScreen'
$box = New-Object Windows.Forms.TextBox
$box.Multiline = $true; $box.AcceptsReturn = $true; $box.Dock = 'Fill'
$form.Controls.Add($box)
$state = @{ ctrlN = $false; enter = $false; order = 'none'; last = $null; textAtN = '' }
$form.Add_KeyDown({
  param($s, $e)
  if ($e.Control -and $e.KeyCode -eq 'N') {
    $state.ctrlN = $true; $state.textAtN = $box.Text
    if ($box.Text.Length -eq 0) { $state.order = 'N-first' } else { $state.order = 'V-first' }
    $e.SuppressKeyPress = $true
  }
  if ($e.KeyCode -eq 'Return') { $state.enter = $true; $e.SuppressKeyPress = $true }
  $state.last = Get-Date
})
$box.Add_TextChanged({ $state.last = Get-Date })
$end = (Get-Date).AddSeconds(25)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  $idle = $state.last -and $box.Text.Length -gt 0 -and ((Get-Date) - $state.last).TotalSeconds -gt 2
  if ($idle -or (Get-Date) -gt $end) { $timer.Stop(); $form.Close() }
})
$form.Add_Shown({ $form.Activate(); $box.Focus(); $timer.Start() })
[void]$form.ShowDialog()
$json = @{ ctrlN = $state.ctrlN; text = $box.Text; enter = $state.enter; order = $state.order } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding $false))
