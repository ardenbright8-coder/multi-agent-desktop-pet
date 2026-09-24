// 启动 Agent 开窗（2026-09-24 用户拍板做法1）：哪个组开桌面上哪个快捷方式。纯函数，开窗本身在 panel-window。
// 开的就是用户平时双击的那个快捷方式（启动参数、账号、编码都跟着快捷方式走，看板不另拼命令）。
// 🚨 只开窗：启动句进剪贴板，用户自己 Ctrl+V、自己按回车——看板绝不替他发。

export interface AgentShortcut {
  /** 桌面上的快捷方式文件名。 */
  shortcut: string;
  /** true＝每点一次开一个新命令窗口；false＝桌面程序，已开着就只是切到前面，看板替用户 Ctrl+N 新开对话。 */
  freshWindow: boolean;
  /** 桌面程序的程序文件名（小写）：按它认「最前面是不是这个程序」，已开着的旧窗口也认。 */
  app?: string;
  /** 开出来后多等几毫秒再贴（默认用看板的统一时长）：启动慢、要先登录的程序在这里加长。 */
  settleMs?: number;
}

const SHORTCUTS: Record<string, AgentShortcut> = {
  claude: { shortcut: "Claude Code 一.lnk", freshWindow: true },
  chatgpt: { shortcut: "Codex.lnk", freshWindow: false, app: "chatgpt.exe" }, // Codex 桌面版的程序文件叫 ChatGPT.exe
  piagent: { shortcut: "Pi 编程智能体.lnk", freshWindow: true },
  // 反重力命令行开窗后先登录好几秒，登录没完就贴会丢（2026-09-24 实测），多等一会儿
  antigravity: { shortcut: "Antigravity 反重力CLI.lnk", freshWindow: true, settleMs: 12_000 },
  hermes: { shortcut: "Hermes.lnk", freshWindow: false, app: "hermes.exe" },
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

/** 桌面程序贴字多要的两样：问一个窗口是哪个程序（完整路径，问不出给空串）、按一次 Ctrl+N。 */
export interface AppPasteDeps extends PasteDeps {
  processOf(hwnd: bigint): string;
  /** 按一次 Ctrl+N（Codex、Hermes 都是「新开对话」）。🚨 不是回车。 */
  pressCtrlN(): void;
}

/** 路径最后一段的文件名，小写（正反斜杠都认）。 */
function exeName(path: string): string {
  return path.split(/[\\/]/).pop()!.toLowerCase();
}

/**
 * 桌面程序（Codex、Hermes）开窗后替用户贴启动句（设定15第四版）：程序已开着时点快捷方式只是把旧窗口切到前面，
 * 所以按「最前面是不是这个程序」认，不按新旧窗口认 → 等它启动好 → Ctrl+N 新开对话 → 还是它在最前面才 Ctrl+V。
 * 每按一个键前都再看一眼最前面还是不是它：用户中途点了别处就停手。🚨 没有回车。
 */
export async function pasteIntoAppWindow(
  app: string,
  deps: AppPasteDeps,
  timing: { pollMs: number; appearTimeoutMs: number; settleMs: number; newChatMs: number },
): Promise<{ ok: boolean; reason: string | null }> {
  const isApp = () => {
    const fg = deps.foreground();
    return fg !== 0n && exeName(deps.processOf(fg)) === app;
  };
  // 要它连续在最前面 settleMs 才算启动好：启动画面、黑框一闪把它挤下去又回来，从回来那刻重新等；
  // 总共等满 appearTimeoutMs 还没稳住就放弃（用户点走了再没回来也是这样）。
  let seen = false;
  let stable = 0;
  for (let waited = 0; stable < timing.settleMs; waited += timing.pollMs) {
    if (isApp()) {
      seen = true;
      stable += timing.pollMs;
    } else {
      stable = 0;
      if (waited >= timing.appearTimeoutMs) {
        return { ok: false, reason: seen ? "等它启动时你点了别的窗口" : "程序窗口没跑到最前面" };
      }
    }
    await deps.sleep(timing.pollMs);
  }
  deps.pressCtrlN();
  await deps.sleep(timing.newChatMs);
  if (!isApp()) return { ok: false, reason: "等它新开对话时你点了别的窗口" };
  deps.pressCtrlV();
  return { ok: true, reason: null };
}
