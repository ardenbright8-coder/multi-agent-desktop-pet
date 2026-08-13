// 把对应 Agent 的窗口拉到前台。完成弹窗上「知道了，回原窗口」走这儿。
// 只按窗口标题 / 进程名打分，不改系统设置，找不到就安静放弃。

import { spawn } from "node:child_process";
import { createLogger } from "../shared/log";

const log = createLogger("window");

export interface FocusAgentHint {
  agent?: string;
  project?: string;
  originPid?: number;
}

const AGENT_NEEDLES: Record<string, string[]> = {
  opencode: ["opencode", "open code"],
  "claude-code": ["claude", "claude code"],
  hermes: ["hermes"],
  pi: ["pi coding", "pi-ai", "pi agent"],
  grok: ["grok", "grok build"],
  codex: ["codex"],
  simulator: [],
};

const REJECT_TITLE = ["多agent桌面宠物", "续枝", "续知"];
const REJECT_PROCESS = ["multi-agent-desktop-pet", "tabbit", "chrome", "msedge", "firefox", "brave", "opera", "iexplore"];
const CLI_HOST_PROCESS = ["grok", "windowsterminal", "windows terminal", "wt", "cmd", "powershell", "pwsh", "conhost"];

export function isRejectedFocusWindow(input: { title: string; processName: string }): boolean {
  const title = String(input.title || "").toLowerCase();
  const proc = String(input.processName || "").toLowerCase().replace(/\.exe$/i, "");
  if (!title) return true;
  if (REJECT_TITLE.some((item) => title.includes(item))) return true;
  if (REJECT_PROCESS.some((item) => proc.includes(item))) return true;
  return false;
}

export function scoreAgentWindow(input: {
  title: string;
  processName: string;
  agent?: string;
  project?: string;
}): number {
  const title = String(input.title || "").toLowerCase();
  const proc = String(input.processName || "").toLowerCase().replace(/\.exe$/i, "");
  if (isRejectedFocusWindow({ title, processName: proc })) return -1;

  // Grok 只回命令行：认 grok.exe。标题里有 Grok 的续枝面板、浏览器页都不是。
  if (input.agent === "grok") {
    if (proc === "grok") return 40;
    if (CLI_HOST_PROCESS.some((item) => proc.includes(item.replace(/\s+/g, ""))) && /grok/.test(title)) return 12;
    return 0;
  }

  let score = 0;
  const needles = [...(AGENT_NEEDLES[input.agent || ""] || [])];
  if (input.agent && !needles.includes(input.agent)) needles.push(input.agent.replace(/-/g, " "));
  for (const raw of needles) {
    const needle = raw.toLowerCase().trim();
    if (!needle) continue;
    if (title.includes(needle)) score += 12;
    if (proc.includes(needle.replace(/\s+/g, ""))) score += 14;
  }
  const project = String(input.project || "").toLowerCase().trim();
  if (project.length >= 2 && title.includes(project)) score += 6;
  return score;
}

/** 点了「返回终端」才调。测试隔离环境里不真切窗口，避免抢自测焦点。 */
export function focusAgentWindow(hint: FocusAgentHint): void {
  if (process.env.AGENT_PET_HUB_HOME) return;
  const agent = String(hint.agent || "").trim();
  const project = String(hint.project || "").trim();
  const originPid = Number(hint.originPid) > 0 ? Math.floor(Number(hint.originPid)) : 0;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class AgentPetFocus {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);",
    "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "}",
    "'@ | Out-Null",
    `$agent = ${psString(agent)}`,
    `$project = ${psString(project)}`,
    `$originPid = ${originPid}`,
    "$needles = @()",
    "if ($agent -eq 'opencode') { $needles += 'opencode','open code' }",
    "elseif ($agent -eq 'claude-code') { $needles += 'claude','claude code' }",
    "elseif ($agent -eq 'hermes') { $needles += 'hermes' }",
    "elseif ($agent -eq 'pi') { $needles += 'pi coding','pi-ai','pi agent' }",
    "elseif ($agent -eq 'grok') { $needles += 'grok','grok build' }",
    "elseif ($agent -eq 'codex') { $needles += 'codex' }",
    "elseif ($agent) { $needles += $agent }",
    "if ($project -and $project.Length -ge 2) { $needles += $project }",
    "function Activate-Handle([IntPtr]$hwnd, [string]$label) {",
    "  if ($hwnd -eq [IntPtr]::Zero) { return }",
    "  if ([AgentPetFocus]::IsIconic($hwnd)) { [void][AgentPetFocus]::ShowWindow($hwnd, 9) }",
    "  [AgentPetFocus]::SwitchToThisWindow($hwnd, $true)",
    "  [void][AgentPetFocus]::SetForegroundWindow($hwnd)",
    "  Write-Output ('FOCUSED ' + $label)",
    "}",
    "function Rejected-Window([string]$title, [string]$proc) {",
    "  $t = $title.ToLowerInvariant(); $p = $proc.ToLowerInvariant()",
    "  if (-not $t) { return $true }",
    "  foreach ($x in @('多agent桌面宠物','续枝','续知')) { if ($t.Contains($x)) { return $true } }",
    "  foreach ($x in @('multi-agent-desktop-pet','tabbit','chrome','msedge','firefox','brave','opera','iexplore')) { if ($p.Contains($x)) { return $true } }",
    "  return $false",
    "}",
    "function Find-WindowByPid([int]$pidTarget) {",
    "  $script:foundWindow = $null",
    "  $cb = [AgentPetFocus+EnumWindowsProc]{ param($hwnd, $lparam)",
    "    $winPid = 0",
    "    [void][AgentPetFocus]::GetWindowThreadProcessId($hwnd, [ref]$winPid)",
    "    if ([int]$winPid -eq $pidTarget -and [AgentPetFocus]::IsWindowVisible($hwnd)) {",
    "      $sb = New-Object System.Text.StringBuilder 512",
    "      [void][AgentPetFocus]::GetWindowText($hwnd, $sb, 512)",
    "      $script:foundWindow = @{ HWND = $hwnd; Title = $sb.ToString() }",
    "      return $false",
    "    }",
    "    return $true",
    "  }",
    "  [void][AgentPetFocus]::EnumWindows($cb, [IntPtr]::Zero)",
    "  return $script:foundWindow",
    "}",
    "function CmdLineOf([int]$pidTarget) {",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$pidTarget\" -ErrorAction SilentlyContinue",
    "  if ($p -and $p.CommandLine) { return [string]$p.CommandLine.ToLowerInvariant() }",
    "  return ''",
    "}",
    "if ($agent -eq 'grok') {",
    "  $cli = Get-Process -Name grok -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -and -not (Rejected-Window $_.MainWindowTitle $_.ProcessName) } | Select-Object -First 1",
    "  if ($cli) { Activate-Handle $cli.MainWindowHandle ('grok pid=' + $cli.Id + ' | ' + $cli.MainWindowTitle); return }",
    "}",
    "if ($originPid -gt 0) {",
    "  $walk = $originPid",
    "  for ($i = 0; $i -lt 8 -and $walk -gt 0; $i++) {",
    "    $proc = Get-Process -Id $walk -ErrorAction SilentlyContinue",
    "    if ($proc) {",
    "      $win = Find-WindowByPid $walk",
    "      if ($win -and $win.Title -and -not (Rejected-Window $win.Title $proc.ProcessName)) {",
    "        if ($agent -ne 'grok' -or $proc.ProcessName -eq 'grok') {",
    "          Activate-Handle $win.HWND ($proc.ProcessName + ' pid=' + $walk + ' | ' + $win.Title)",
    "          return",
    "        }",
    "      } elseif ($win -and -not $win.Title -and $agent -ne 'grok') {",
    "        $cmd = CmdLineOf $walk",
    "        $cmdHit = $false",
    "        foreach ($needle in $needles) { if ($cmd.Contains([string]$needle.ToLowerInvariant())) { $cmdHit = $true; break } }",
    "        if ($cmdHit) { Activate-Handle $win.HWND ($proc.ProcessName + ' pid=' + $walk + ' | 终端窗口'); return }",
    "      }",
    "    }",
    "    $parent = (Get-CimInstance Win32_Process -Filter (\"ProcessId=$walk\") -ErrorAction SilentlyContinue).ParentProcessId",
    "    if (-not $parent -or $parent -eq $walk) { break }",
    "    $walk = [int]$parent",
    "  }",
    "}",
    "$best = $null; $bestScore = 0",
    "$script:allWindows = @()",
    "$allCb = [AgentPetFocus+EnumWindowsProc]{ param($hwnd, $lparam)",
    "  $winPid = 0",
    "  [void][AgentPetFocus]::GetWindowThreadProcessId($hwnd, [ref]$winPid)",
    "  if ([AgentPetFocus]::IsWindowVisible($hwnd)) {",
    "    $sb = New-Object System.Text.StringBuilder 512",
    "    [void][AgentPetFocus]::GetWindowText($hwnd, $sb, 512)",
    "    $script:allWindows += @{ PID = [int]$winPid; HWND = $hwnd; Title = $sb.ToString() }",
    "  }",
    "  return $true",
    "}",
    "[void][AgentPetFocus]::EnumWindows($allCb, [IntPtr]::Zero)",
    "$seenPids = @{}",
    "foreach ($w in $script:allWindows) {",
    "  if ($seenPids.ContainsKey($w.PID)) { continue }",
    "  $seenPids[$w.PID] = $true",
    "  $proc = Get-Process -Id $w.PID -ErrorAction SilentlyContinue",
    "  if (-not $proc) { continue }",
    "  $procName = $proc.ProcessName.ToLowerInvariant()",
    "  $title = $w.Title.ToLowerInvariant()",
    "  if (Rejected-Window $w.Title $proc.ProcessName) {",
    "    if (-not $w.Title -and $agent -ne 'grok') {",
    "      $cmd = CmdLineOf $w.PID",
    "      $cmdHit = $false",
    "      foreach ($needle in $needles) { if ($cmd.Contains([string]$needle.ToLowerInvariant())) { $cmdHit = $true; break } }",
    "      if (-not $cmdHit) { continue }",
    "    } else { continue }",
    "  }",
    "  $score = 0",
    "  if ($agent -eq 'grok') {",
    "    if ($procName -eq 'grok') { $score = 40 }",
    "    elseif ((@('windowsterminal','wt','cmd','powershell','pwsh','conhost') -contains $procName) -and $title.Contains('grok')) { $score = 12 }",
    "  } else {",
    "    foreach ($needle in $needles) {",
    "      $n = [string]$needle; if (-not $n) { continue }",
    "      $nl = $n.ToLowerInvariant()",
    "      if ($title.Contains($nl)) { $score += 12 }",
    "      if ($procName.Contains(($nl -replace '\\s',''))) { $score += 14 }",
    "    }",
    "    if (-not $w.Title) { $score += 20 }",
    "  }",
    "  if ($score -gt $bestScore) { $bestScore = $score; $best = @{ HWND = $w.HWND; Title = $w.Title; Name = $proc.ProcessName } }",
    "}",
    "if (-not $best -or $bestScore -lt 10) { Write-Output 'NO_MATCH'; return }",
    "Activate-Handle $best.HWND ($best.Name + ' | ' + $best.Title)",
  ].join("\n");

  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { out += String(chunk); });
  child.on("error", (error) => log.出事("回原窗口切过去失败", error, "focusAgent"));
  child.on("close", () => {
    const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) || "NO_OUTPUT";
    if (line.startsWith("FOCUSED")) log.记(`回终端已切到 ${line.slice(8)}`, "focusAgent");
    else log.记(`回终端没找到窗口 agent=${agent || "?"} project=${project || "?"} pid=${originPid || "?"} ${line}`, "focusAgent");
  });
}

function psString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
