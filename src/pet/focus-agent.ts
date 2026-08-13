// 把对应 Agent 的窗口拉到前台。完成弹窗上「知道了，回原窗口」走这儿。
// 只按窗口标题 / 进程名打分，不改系统设置，找不到就安静放弃。

import { spawn } from "node:child_process";
import { createLogger } from "../shared/log";

const log = createLogger("window");

export interface FocusAgentHint {
  agent?: string;
  project?: string;
}

const AGENT_NEEDLES: Record<string, string[]> = {
  opencode: ["opencode", "open code"],
  "claude-code": ["claude", "claude code"],
  hermes: ["hermes"],
  pi: ["pi coding", "pi-ai", "pi agent"],
  simulator: [],
};

export function scoreAgentWindow(input: {
  title: string;
  processName: string;
  agent?: string;
  project?: string;
}): number {
  const title = String(input.title || "").toLowerCase();
  const proc = String(input.processName || "").toLowerCase().replace(/\.exe$/i, "");
  if (!title || title.includes("多agent桌面宠物") || proc.includes("multi-agent-desktop-pet")) return -1;

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

/** 点了「回原窗口」才调。测试隔离环境里不真切窗口，避免抢自测焦点。 */
export function focusAgentWindow(hint: FocusAgentHint): void {
  if (process.env.AGENT_PET_HUB_HOME) return;
  const agent = String(hint.agent || "").trim();
  const project = String(hint.project || "").trim();
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class AgentPetFocus {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
    "}",
    "'@ | Out-Null",
    `$agent = ${psString(agent)}`,
    `$project = ${psString(project)}`,
    "$needles = @()",
    "if ($agent -eq 'opencode') { $needles += 'opencode','open code' }",
    "elseif ($agent -eq 'claude-code') { $needles += 'claude','claude code' }",
    "elseif ($agent -eq 'hermes') { $needles += 'hermes' }",
    "elseif ($agent -eq 'pi') { $needles += 'pi coding','pi-ai','pi agent' }",
    "elseif ($agent) { $needles += $agent }",
    "if ($project -and $project.Length -ge 2) { $needles += $project }",
    "$best = $null; $bestScore = 0",
    "Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle } | ForEach-Object {",
    "  $title = $_.MainWindowTitle.ToLowerInvariant()",
    "  $proc = $_.ProcessName.ToLowerInvariant()",
    "  if ($title.Contains('多agent桌面宠物') -or $proc.Contains('multi-agent-desktop-pet')) { return }",
    "  $score = 0",
    "  foreach ($needle in $needles) {",
    "    $n = [string]$needle; if (-not $n) { continue }",
    "    $nl = $n.ToLowerInvariant()",
    "    if ($title.Contains($nl)) { $score += 12 }",
    "    if ($proc.Contains(($nl -replace '\\s',''))) { $score += 14 }",
    "  }",
    "  if ($score -gt $bestScore) { $bestScore = $score; $best = $_ }",
    "}",
    "if (-not $best -or $bestScore -lt 10) { Write-Output 'NO_MATCH'; return }",
    "$hwnd = $best.MainWindowHandle",
    "if ([AgentPetFocus]::IsIconic($hwnd)) { [void][AgentPetFocus]::ShowWindow($hwnd, 9) }",
    "[void][AgentPetFocus]::SetForegroundWindow($hwnd)",
    "Write-Output ('FOCUSED ' + $best.ProcessName + ' | ' + $best.MainWindowTitle)",
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
    if (line.startsWith("FOCUSED")) log.记(`回原窗口已切到 ${line.slice(8)}`, "focusAgent");
    else log.记(`回原窗口没找到对应窗口 agent=${agent || "?"} project=${project || "?"} ${line}`, "focusAgent");
  });
}

function psString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
