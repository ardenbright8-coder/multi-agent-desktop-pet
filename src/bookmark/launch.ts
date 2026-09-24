// 启动 Agent 开窗（2026-09-24 用户拍板做法1）：哪个组开桌面上哪个快捷方式。纯函数，开窗本身在 panel-window。
// 开的就是用户平时双击的那个快捷方式（启动参数、账号、编码都跟着快捷方式走，看板不另拼命令）。
// 🚨 只开窗：启动句进剪贴板，用户自己 Ctrl+V、自己按回车——看板绝不替他发。

export interface AgentShortcut {
  /** 桌面上的快捷方式文件名。 */
  shortcut: string;
  /** true＝每点一次开一个新命令窗口；false＝桌面程序，已开着就只是切到前面，要用户自己新开对话。 */
  freshWindow: boolean;
}

const SHORTCUTS: Record<string, AgentShortcut> = {
  claude: { shortcut: "Claude Code 一.lnk", freshWindow: true },
  chatgpt: { shortcut: "Codex.lnk", freshWindow: false },
  piagent: { shortcut: "Pi 编程智能体.lnk", freshWindow: true },
  hermes: { shortcut: "Hermes.lnk", freshWindow: false },
};

/** 组名 → 桌面快捷方式；用户自己加的组认不出是谁，返回 null（只复制不开窗）。 */
export function agentShortcutFor(group: string): AgentShortcut | null {
  return SHORTCUTS[group.replace(/\s+/g, "").toLowerCase()] ?? null;
}

/** 替用户按键要用到的 Windows 能力，单测换成假的。 */
export interface PasteDeps {
  /** 现在最前面的窗口（没有就是 0）。 */
  foreground(): bigint;
  /** 按一次 Ctrl+V。🚨 只有这一个按键，没有回车。 */
  pressCtrlV(): void;
  sleep(ms: number): Promise<void>;
}

/**
 * 开窗后替用户贴启动句（设定15第三版·做法2）：等一个开窗前没有的窗口跑到最前面 → 等它启动好 →
 * 它还在最前面才按一次 Ctrl+V。用户中途点了别的窗口、新窗口一直没出来，一律不贴，让用户自己贴。
 * before＝开窗前就有的全部窗口，最前面换成其中任何一个（包括看板自己）都不算新窗口。
 */
export async function pasteIntoNewWindow(
  before: ReadonlySet<bigint>,
  deps: PasteDeps,
  timing: { pollMs: number; appearTimeoutMs: number; settleMs: number },
): Promise<{ ok: boolean; reason: string | null }> {
  let fresh = 0n;
  for (let waited = 0; ; waited += timing.pollMs) {
    const fg = deps.foreground();
    if (fg !== 0n && !before.has(fg)) {
      fresh = fg;
      break;
    }
    if (waited >= timing.appearTimeoutMs) return { ok: false, reason: "新窗口没跑到最前面" };
    await deps.sleep(timing.pollMs);
  }
  await deps.sleep(timing.settleMs);
  if (deps.foreground() !== fresh) return { ok: false, reason: "等它启动时你点了别的窗口" };
  deps.pressCtrlV();
  return { ok: true, reason: null };
}
