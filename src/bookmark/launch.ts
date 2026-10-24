// 启动 Agent 开窗（2026-09-24 用户拍板做法1）：哪个组开哪个快捷方式。纯函数，开窗本身在 panel-window。
// 开的就是用户平时双击的那个快捷方式（启动参数、账号、编码都跟着快捷方式走，看板不另拼命令）。
// 🚨 只开窗：启动句进剪贴板，用户自己 Ctrl+V、自己按回车——看板绝不替他发。
// 2026-10-24（看板 Claude 01）：开哪个改成设置文件「启动哪个程序.json」，新加一家填一行、不改代码；
// 每组按顺序找，这台电脑上有哪个开哪个（根和燊一修桌面上的快捷方式不一样，E 盘入口夹那份两边都有）。

/** 一个能开的东西。 */
export interface LaunchTarget {
  /** 只写名字＝桌面上的快捷方式（不带 .lnk 也行）；写完整路径＝就开那个文件。 */
  open: string;
  /** true＝每点一次开一个新命令窗口；false＝桌面程序，已开着就只是切到前面，看板替用户 Ctrl+N 新开对话。 */
  freshWindow: boolean;
  /** 桌面程序的程序文件名（小写）：按它认「最前面是不是这个程序」，已开着的旧窗口也认。 */
  app?: string;
  /** 开出来后多等几毫秒再贴（默认用看板的统一时长）：启动慢、要先登录的程序在这里加长。 */
  settleMs?: number;
}

/** 设置文件名（看板数据夹里，两套系统共用一份）。 */
export const LAUNCH_CONFIG_FILE = "启动哪个程序.json";

const ENTRY = "E:\\个人AI资源管理\\10_按项目存放（某个项目专用的脚本和资料）\\01_手作园（自己从0搓的·应用网页工具）\\入口（CLI和图标·小东西·不是大应用）";

/** 没有设置文件时的默认（也是第一次写出设置文件的内容）。键＝组名去空格小写。 */
export const DEFAULT_LAUNCH: Record<string, LaunchTarget[]> = {
  // 燊一修桌面叫「Claude Code 一」，根桌面叫「Claude Code 根」（2026-10-24：根这边六个点开不了就是没认这个名字）
  claude: [
    { open: "Claude Code 一", freshWindow: true },
    { open: "Claude Code 根", freshWindow: true },
  ],
  // Codex 桌面版的程序文件叫 ChatGPT.exe；没装桌面版的那套用 E 盘的命令行版
  chatgpt: [
    { open: "Codex", freshWindow: false, app: "chatgpt.exe" },
    { open: `${ENTRY}\\Codex一点就开（双击进命令窗口）\\Codex CLI.lnk`, freshWindow: true },
  ],
  piagent: [
    { open: "Pi 编程智能体", freshWindow: true },
    { open: `${ENTRY}\\Pi一点就开（双击进命令窗口·永久入口）\\Pi 编程智能体.lnk`, freshWindow: true },
  ],
  // 反重力命令行开窗后先登录好几秒，登录没完就贴会丢（2026-09-24 实测），多等一会儿
  antigravity: [
    { open: "Antigravity 反重力CLI", freshWindow: true, settleMs: 12_000 },
    { open: `${ENTRY}\\Antigravity一点就开（双击进命令窗口）\\Antigravity 反重力CLI.lnk`, freshWindow: true, settleMs: 12_000 },
  ],
  hermes: [{ open: "Hermes", freshWindow: false, app: "hermes.exe" }],
};

/** 组名 → 设置里的键（去空格、小写）。 */
export function launchKey(group: string): string {
  return group.replace(/\s+/g, "").toLowerCase();
}

/**
 * 读设置文件：{ "组名": [{ "开": "...", "新窗口": true, "程序名": "x.exe", "多等毫秒": 12000 }, ...] }。
 * 文件里写了的组整组照文件，没写的组用默认；坏档、写错的条目跳过。「说明」这类不是数组的键不管。
 */
export function parseLaunchConfig(text: string): Record<string, LaunchTarget[]> {
  const out: Record<string, LaunchTarget[]> = { ...DEFAULT_LAUNCH };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [group, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const targets: LaunchTarget[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const open = typeof r["开"] === "string" ? r["开"].trim() : "";
      if (!open) continue;
      const target: LaunchTarget = { open, freshWindow: r["新窗口"] !== false };
      if (typeof r["程序名"] === "string" && r["程序名"].trim()) target.app = r["程序名"].trim().toLowerCase();
      if (typeof r["多等毫秒"] === "number" && r["多等毫秒"] > 0) target.settleMs = r["多等毫秒"];
      targets.push(target);
    }
    out[launchKey(group)] = targets;
  }
  return out;
}

/** 写出设置文件的内容（第一次没有文件时用默认生成，给人和 AI 照着改）。 */
export function formatLaunchConfig(config: Record<string, LaunchTarget[]> = DEFAULT_LAUNCH): string {
  const names: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", piagent: "Pi Agent", antigravity: "Antigravity", hermes: "Hermes" };
  const doc: Record<string, unknown> = {
    说明: "看板六个点「启动 Agent」开哪个程序。每组按顺序找，这台电脑上有哪个开哪个（根和燊一修共用这一份）。「开」只写名字＝桌面上的快捷方式；写完整路径＝就开那个文件。「新窗口」true＝命令窗口每次开新的；false＝桌面程序，要填「程序名」，看板替你 Ctrl+N 新开对话。「多等毫秒」＝开出来多等一会儿再贴（要先登录的程序）。新加一家：照样子加一组，组名跟看板上的组名一样就行。",
  };
  for (const [key, targets] of Object.entries(config)) {
    doc[names[key] ?? key] = targets.map((t) => ({
      开: t.open,
      新窗口: t.freshWindow,
      ...(t.app ? { 程序名: t.app } : {}),
      ...(t.settleMs ? { 多等毫秒: t.settleMs } : {}),
    }));
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 组名 → 能开的东西（按顺序找）；设置里没这个组 → null（只复制不开窗）。 */
export function agentShortcutFor(group: string, config: Record<string, LaunchTarget[]> = DEFAULT_LAUNCH): LaunchTarget[] | null {
  const list = config[launchKey(group)];
  return list && list.length ? list : null;
}

/** 「开」写的是完整路径（带盘符或 \\ 开头）吗。 */
export function isAbsoluteTarget(open: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(open) || open.startsWith("\\\\");
}

/** 名字补上 .lnk（已带后缀的不动）。 */
export function shortcutFileName(open: string): string {
  return /\.[a-z0-9]{2,4}$/i.test(open) ? open : `${open}.lnk`;
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
