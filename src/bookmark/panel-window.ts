// 书签台面板：独立 BrowserWindow + 全局热键 + 本块专属 IPC。
// 🚨 隔离铁律：本块断网/崩溃不许连坐桌宠本体。对外只露出下面三个函数，
// app.ts 装配时调 initBookmarkPanel()；托盘入口经 app.ts 注入 PetTrayActions（pet 块不 import 本块）。
//
// 改版二（2026-09-10 用户拍板）：看板**常驻贴屏**——启动即显示、贴主屏右缘占 1/3 宽、
// **总在其他窗口之下**（压在桌面上、被别的窗口盖，绝不挡人）；失焦即沉底，聚焦期间不压
// （用户正打字时不许被盖）。
// 改版三（2026-09-11 用户拍板）：F3 显示/收起撤销——看板**永远常驻显示**（启动自动显示、
// 失焦 2 秒自动沉底 HWND_BOTTOM 保留不动）；新增 F1 = 置顶/沉底开关：按一下提至最上层
// （koffi SetWindowPos HWND_TOPMOST），再按一下沉回最底层；与失焦自动沉底共存，
// 状态标志位只有 F1 和「置顶时点了看板外面」翻转（纯函数 pinToggleSteps 在 dock.ts，单测覆盖）。

import { basename, join } from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, nativeImage, net, screen, shell } from "electron";
import { createLogger } from "../shared/log";
import { writeJsonAtomic } from "../shared/atomic-file";
import { attachmentsRoot, bookmarkAppearancePath, bookmarkDataDirectory, isIsolatedRun } from "../shared/paths";
import { computeDockedBounds, parseSavedWindowSize, HWND_BOTTOM, SWP_ZORDER_FLAGS, pinToggleSteps } from "./dock";
import { AgentRoster } from "./agents";
import { BookmarkStore, normalizeForSystem, type BookmarkRecord } from "./store";
import { ensureBookmarkInboxStarted, readInboxConfig, stopBookmarkInbox } from "./inbox";
import { buildBoardSnapshot, collectProjects, startBoardPublisher, type BoardProjectNode } from "./board-sync";
import { formatClaimMessage, startBookmarkCliServer, type CliRecord } from "./cli-server";
import { indexBoard } from "./board-index";
import { handleDispatchAction } from './dispatch-cli';
import { listBoardSkills, readBoardSkill } from './skills';
import { clampOpacity, DEFAULT_BOARD_OPACITY, parseAppearance } from "./appearance";
import { clampZoom, DEFAULT_BOARD_ZOOM, parseZoom, stepZoom, zoomActionForKey } from "./zoom";
import { createProjectFolder, createProjectMarkdown, ensureProjectsRoot, listProjects, projectsRoot, reorderProjects, resolveProjectPath } from "./projects";
import { composeForAgent, listTemplates } from "./templates";
import {
  agentShortcutFor, formatLaunchConfig, isAbsoluteTarget, LAUNCH_CONFIG_FILE, launchKey, parseLaunchConfig, pasteIntoAppWindow, pasteIntoNewWindow,
  shortcutFileName, type LaunchTarget,
} from "./launch";
import { registerBookmarkImageIpc } from "./image-ipc";
import { imagesForAgent } from "./inline-images";
import { findFileConflicts, formatItemFile, itemFilePath, ITEM_FILES_DIR, parseAllowedFiles, syncItemFiles } from "./item-files";
import { readPiModels, setPiModel } from "./pi-model";
import { vectorSearch } from "./vector-search";
import { parseBoardMode, type BoardMode } from "./sleep-mode";
import {
  activeModel, askSearchProjects, knownProjects, projectKey, searchByText, BUNDLE_NAME_RULES, buildCheckTask, buildGroupTask, buildItemTask, buildLedger, CHECK_RULES, checkModelInput, EFFORTS, groupsForOrganizer, hardRulesText,
  boardFingerprint, freshNote, ITEM_RULES, parseNameBook, runBundleNames, type NameBook, liveHintBook, liveNoteBook, modelLabel, ORGANIZER_RULES, organizeRows, parseHintBook, parseNoteBook, parseOrganizerConfig, parseRunRecords,
  pruneRunRecords, RULES_DIR, runChecker, runItemNotes, runOrganizer, shortSummary, takeModelSwitches, testModel,
  type Effort, type FetchFn, type HintBook, type NoteBook, type OrganizerConfig, type RecordRow, type RunRecord,
} from "./organizer";

const log = createLogger("bookmark");
const PROCESS_STARTED_AT = Date.now();

/** 全局热键：F1 = 置顶/沉底开关（改版三 2026-09-11 拍板；旧 F3 显示/收起已撤）。 */
export const BOOKMARK_HOTKEY = "F1";

/** 沉底兜底定时器：失焦事件之外，每 2 秒再检查一遍（没聚焦就压底）。 */
const SINK_TIMER_MS = 2_000;

// ── 窗口尺寸记性（2026-09-10 用户拍板）：默认尺寸 = 用户现在拖的这个，之后手动 resize 也记住，
// 以后每次开就是这个尺寸。只存宽高，位置永远贴右缘由几何函数算。

/** 用户拍板时的实测值（2026-09-10 Win32 GetWindowRect 实测，DPI 96 无换算）：无存档时的默认尺寸。 */
const DEFAULT_PANEL_SIZE = { width: 1025, height: 1399 };
const WINDOW_BOUNDS_FILE = "window-bounds.json";
const RESIZE_SAVE_DEBOUNCE_MS = 1_500;

function windowBoundsPath(): string {
  return join(bookmarkDataDirectory(), WINDOW_BOUNDS_FILE);
}

/** 读存档宽高。缺文件/坏档一律 undefined（回落默认尺寸，不炸不存证——尺寸档不值钱）。 */
function readSavedWindowSize(): { width: number; height: number } | undefined {
  try {
    const path = windowBoundsPath();
    if (!existsSync(path)) return undefined;
    return parseSavedWindowSize(readFileSync(path, "utf8")) ?? undefined;
  } catch (error) {
    log.出事("看板尺寸存档读取失败（回落默认尺寸）", error, "window");
    return undefined;
  }
}

function writeSavedWindowSize(size: { width: number; height: number }): void {
  try {
    writeJsonAtomic(windowBoundsPath(), size);
  } catch (error) {
    log.出事("看板尺寸存盘失败（不影响使用，下次 resize 再试）", error, "window");
  }
}

/** 版本戳：启动时算一次（git 短 hash + 当前时间），整个运行期不变——页面刷新不变，Ctrl+R 整程序重开才变。
 * 用户靠它一眼分辨“现在跑的是哪一版”。打包环境没 git 就只剩时间，一样能分。 */
const PANEL_VERSION: string = (() => {
  let hash = "";
  try {
    hash = execSync("git rev-parse --short HEAD", {
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    // 打包环境 / 没 git：只显示时间，够分辨新旧。
  }
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return hash ? `${hash}·${stamp}` : stamp;
})();

let panel: BrowserWindow | null = null;
/** 退出程序时才置真；窗口 closed 时据此区分「真退出」和「被意外关掉要重建」。 */
let panelShuttingDown = false;
let store: BookmarkStore | null = null;
let roster: AgentRoster | null = null;
let hotkeyRegistered = false;
/** 真机 Ctrl+R 走编译+整程序重开；自测保持面板刷新。 */
let liveRestart = false;
let openAgents = false;
let pendingShow = false;
let rendererReady = false;
let sinkTimer: NodeJS.Timeout | null = null;
let sinkWarned = false;
/** F1 置顶态标志：true = 看板带着 WS_EX_TOPMOST（提在所有普通窗口之上）。
 *  只有 F1 开关（toggleBoardPin）翻转它；失焦沉底/2秒兑底照旧只发 HWND_BOTTOM，不碰这标志。 */
let pinnedTopmost = false;

// koffi（Win32 SetWindowPos）惰性加载：加载失败只警告一次，看板照常工作（只是不沉底），
// 隔离铁律——这里出任何幺蛾子不许连坐桌宠本体。
// HWND 传参用 uintptr_t + BigInt（实测 void* + Buffer 会静默失败返回 false）。
type SetWindowPosFn = (hwnd: bigint, after: bigint, x: number, y: number, cx: number, cy: number, flags: number) => boolean;
let setWindowPos: SetWindowPosFn | null = null;
type SendMessageFn = (hwnd: bigint, msg: number, wParam: bigint, lParam: bigint) => bigint;
let sendMessage: SendMessageFn | null = null;
/** WM_NCACTIVATE：告诉 Windows「这个窗口的外观按『正在用』画」。只管外观，不抢焦点、不改 Z 序。 */
const WM_NCACTIVATE = 0x0086;

function loadSink(): SetWindowPosFn | null {
  if (setWindowPos) return setWindowPos;
  if (sinkWarned) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    setWindowPos = user32.func(
      "bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32_t uFlags)",
    ) as unknown as SetWindowPosFn;
    sendMessage = user32.func(
      "intptr_t __stdcall SendMessageW(uintptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)",
    ) as unknown as SendMessageFn;
    log.记("Win32 SetWindowPos 已就位（总在其他窗口之下）", "window");
    return setWindowPos;
  } catch (error) {
    sinkWarned = true;
    log.出事("koffi/user32 加载失败，看板降级为普通窗口（不沉底、不影响使用）", error, "window");
    return null;
  }
}

/** 启动 Agent 贴字用的 Windows 能力（设定15第三版）：列出全部顶层窗口、看谁在最前面、按一次 Ctrl+V。 */
interface LaunchWin32 {
  windows(): bigint[];
  foreground(): bigint;
  /** 这个窗口是哪个程序（完整路径，问不出给空串）——认 Codex、Hermes 用。 */
  processOf(hwnd: bigint): string;
  pressCtrlV(): void;
  /** Codex、Hermes 的「新开对话」。 */
  pressCtrlN(): void;
}
let launchWin32: LaunchWin32 | null | undefined;

/** 惰性加载；失败只记一次日志，启动 Agent 退回「只开窗、用户自己贴」。 */
function loadLaunchWin32(): LaunchWin32 | null {
  if (launchWin32 !== undefined) return launchWin32;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    koffi.proto("bool __stdcall BmEnumWindowsProc(uintptr_t hwnd, intptr_t lParam)");
    const enumWindows = user32.func("bool __stdcall EnumWindows(BmEnumWindowsProc *cb, intptr_t lParam)") as unknown as (
      cb: (hwnd: number | bigint) => boolean,
      lParam: number,
    ) => boolean;
    const getForeground = user32.func("uintptr_t __stdcall GetForegroundWindow()") as unknown as () => number | bigint;
    const keybdEvent = user32.func(
      "void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)",
    ) as unknown as (vk: number, scan: number, flags: number, extra: number) => void;
    const getWindowPid = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)") as unknown as (
      hwnd: bigint,
      pid: number[],
    ) => number;
    const kernel32 = koffi.load("kernel32.dll");
    const openProcess = kernel32.func("uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)") as unknown as (
      access: number,
      inherit: boolean,
      pid: number,
    ) => number | bigint;
    const queryImageName = kernel32.func(
      "bool __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)",
    ) as unknown as (process: number | bigint, flags: number, name: Uint16Array, size: number[]) => boolean;
    const closeHandle = kernel32.func("bool __stdcall CloseHandle(uintptr_t handle)") as unknown as (handle: number | bigint) => boolean;
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const VK_CONTROL = 0x11;
    const VK_V = 0x56;
    const VK_N = 0x4e;
    const KEYEVENTF_KEYUP = 0x0002;
    const pressCtrl = (vk: number) => {
      keybdEvent(VK_CONTROL, 0, 0, 0);
      keybdEvent(vk, 0, 0, 0);
      keybdEvent(vk, 0, KEYEVENTF_KEYUP, 0);
      keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    };
    launchWin32 = {
      windows: () => {
        const list: bigint[] = [];
        enumWindows((hwnd) => {
          list.push(BigInt(hwnd));
          return true;
        }, 0);
        return list;
      },
      foreground: () => BigInt(getForeground()),
      processOf: (hwnd) => {
        const pid = [0];
        getWindowPid(hwnd, pid);
        if (!pid[0]) return "";
        const process = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
        if (!process) return "";
        try {
          const name = new Uint16Array(1024);
          const size = [name.length];
          return queryImageName(process, 0, name, size) ? String.fromCharCode(...name.subarray(0, size[0])) : "";
        } finally {
          closeHandle(process);
        }
      },
      // 🚨 只有 Ctrl+V / Ctrl+N 这两组按下/松开，没有回车。
      pressCtrlV: () => pressCtrl(VK_V),
      pressCtrlN: () => pressCtrl(VK_N),
    };
  } catch (error) {
    launchWin32 = null;
    log.出事("启动 Agent 贴字用的 Windows 接口加载失败（只开窗，用户自己贴）", error, "cli");
  }
  return launchWin32;
}

// ── 鼠标碰到看板就能直接按键（2026-10-24 看板 Claude 01）──────────────
// 用户在 Claude Code 里聊着，鼠标挪到看板上按 Ctrl+X 不灵：键盘还在原来那个窗口，得先点一下看板。
// 现在鼠标进看板停一下（界面那边等 250ms）就把前台拿过来；只碰了一下、没点没按键就移走，前台还给原来那个窗口。
// Windows 不许后台程序随便抢前台，所以先跟当前前台窗口的线程「挂一下」再 SetForegroundWindow。

interface FocusWin32 {
  foreground(): bigint;
  isWindow(hwnd: bigint): boolean;
  /** 把这个窗口拿到前台；Windows 不给就返回 false。 */
  bringToFront(hwnd: bigint): boolean;
}
let focusWin32: FocusWin32 | null | undefined;
/** 这次前台是鼠标碰进来拿的：拿之前在前台的那个窗口（还焦点用），0＝没有可还的。 */
let hoverGaveFrom = 0n;
/** 只在真机常驻看板上做：验证脚本、自测不许抢真机前台。 */
let hoverFocusEnabled = false;

function loadFocusWin32(): FocusWin32 | null {
  if (focusWin32 !== undefined) return focusWin32;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const getForeground = user32.func("uintptr_t __stdcall GetForegroundWindow()") as unknown as () => number | bigint;
    const setForeground = user32.func("bool __stdcall SetForegroundWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const isWindow = user32.func("bool __stdcall IsWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const threadOf = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, uintptr_t pid)") as unknown as (
      hwnd: bigint,
      pid: number,
    ) => number;
    const attachInput = user32.func("bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)") as unknown as (
      from: number,
      to: number,
      attach: boolean,
    ) => boolean;
    const currentThread = kernel32.func("uint32_t __stdcall GetCurrentThreadId()") as unknown as () => number;
    focusWin32 = {
      foreground: () => BigInt(getForeground()),
      isWindow: (hwnd) => hwnd !== 0n && isWindow(hwnd),
      bringToFront: (hwnd) => {
        const fg = BigInt(getForeground());
        const me = currentThread();
        const fgThread = fg ? threadOf(fg, 0) : 0;
        const attached = fgThread !== 0 && fgThread !== me && attachInput(me, fgThread, true);
        try {
          return setForeground(hwnd);
        } finally {
          if (attached) attachInput(me, fgThread, false);
        }
      },
    };
  } catch (error) {
    focusWin32 = null;
    log.出事("鼠标碰到就拿焦点用的 Windows 接口加载失败（照旧点一下看板再按键）", error, "window");
  }
  return focusWin32;
}

function hoverFocusBoard(): boolean {
  const win = panel;
  if (!hoverFocusEnabled || !win || win.isDestroyed() || !win.isVisible() || win.isFocused() || pinnedTopmost) return false;
  try {
    const w32 = loadFocusWin32();
    if (!w32) return false;
    const before = w32.foreground();
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    if (!w32.bringToFront(hwnd)) return false;
    win.focus(); // 让页面也知道自己拿到焦点了
    hoverGaveFrom = before !== hwnd ? before : 0n;
    return true;
  } catch (error) {
    log.出事("鼠标碰到看板拿焦点失败（照旧点一下再按键）", error, "window");
    return false;
  }
}

/** 只碰了一下就移走：前台还给原来那个窗口（看板失焦照旧沉底）。原窗口关了就不还。 */
function hoverGiveBack(): boolean {
  const back = hoverGaveFrom;
  hoverGaveFrom = 0n;
  const win = panel;
  if (!back || !win || win.isDestroyed() || !win.isFocused() || pinnedTopmost) return false;
  try {
    const w32 = loadFocusWin32();
    if (!w32 || !w32.isWindow(back)) return false;
    return w32.bringToFront(back);
  } catch (error) {
    log.出事("鼠标移走还焦点失败（点一下原来的窗口就行）", error, "window");
    return false;
  }
}

/** 把面板压到 Z 序最底（HWND_BOTTOM）。失败静默——沉不了底也只是不好看，不是故障。 */
function sinkToBottom(win: BrowserWindow): void {
  try {
    const fn = loadSink();
    if (!fn || win.isDestroyed()) return;
    // getNativeWindowHandle() 是 HWND 的字节串；64 位下读 BigInt 塞进 uintptr_t。
    const hwndBig = win.getNativeWindowHandle().readBigUInt64LE(0);
    const ok = fn(hwndBig, BigInt(HWND_BOTTOM), 0, 0, 0, 0, SWP_ZORDER_FLAGS);
    if (!ok) log.出事("SetWindowPos 返回 false（沉底没生效）", undefined, "window");
  } catch (error) {
    log.出事("沉底失败（不影响使用）", error, "window");
  }
}

/** 毛玻璃常亮（2026-09-24 用户拍板：「永远固定成鼠标点那个状态」）：Win11 的 acrylic 只在窗口「正在用」时画，
 *  失焦就换成一块死灰。看板常驻沉底、大部分时间失焦 → 大部分时间是灰的。每次失焦/亮窗后补发一个
 *  WM_NCACTIVATE(TRUE)，让 Windows 接着按「正在用」画毛玻璃。只管外观：键盘焦点、Z 序都不动。失败静默。 */
function keepAcrylicLit(win: BrowserWindow): void {
  try {
    if (!loadSink() || !sendMessage || win.isDestroyed()) return;
    const hwndBig = win.getNativeWindowHandle().readBigUInt64LE(0);
    sendMessage(hwndBig, WM_NCACTIVATE, 1n, 0n);
  } catch (error) {
    log.出事("毛玻璃常亮失败（只是失焦会变灰，不影响使用）", error, "window");
  }
}

/** F1 置顶开关：提顶（HWND_TOPMOST）↔ 沉回最底层（先 NOTOPMOST 摘样式再 BOTTOM，纯函数
 *  pinToggleSteps 给步骤）。标志位只有这里翻转；失败时保持旧状态，别让标志跟实际 Z 序劈叉。 */
function toggleBoardPin(): void {
  const win = panel;
  if (!win || win.isDestroyed()) return;
  try {
    const fn = loadSink();
    if (!fn) return; // koffi 不可用已警告过一次：无从置顶，保持原状。
    const hwndBig = win.getNativeWindowHandle().readBigUInt64LE(0);
    for (const step of pinToggleSteps(pinnedTopmost)) {
      const ok = fn(hwndBig, BigInt(step.insertAfter), 0, 0, 0, 0, SWP_ZORDER_FLAGS);
      if (!ok) {
        log.出事(`SetWindowPos(${step.insertAfter}) 返回 false（F1 置顶开关没生效）`, undefined, "window");
        return;
      }
      pinnedTopmost = step.pinnedAfter;
    }
    // 置顶顺手拿焦点：这样点看板外面才有「失焦」可认，失焦就收起（热键刚按下，Windows 允许本程序拿前台）。
    if (pinnedTopmost) win.focus();
    log.记(pinnedTopmost ? "F1：看板置顶（点看板外面或再按一次沉回最底层）" : "F1：看板沉回最底层", "window");
  } catch (error) {
    log.出事("F1 置顶开关失败（不影响使用）", error, "window");
  }
}

/** Ctrl+R 整程序重开时带上，滤掉旧的再追加，免得连按越攒越多。 */
const RELAUNCH_FLAG = "--bookmark-relaunch";

export interface BookmarkPanelOptions {
  /** 注册全局热键。自测模式传 false，别跟真机抢热键。 */
  hotkey?: boolean;
  /** 常驻模式：装配完立刻建窗并显示（贴右缘、沉底）。自测模式传 false，走旧惰性路径，别干扰测试。 */
  resident?: boolean;
  /** 收信模块（连 ntfy 邮局收手机消息）。自测模式传 false，别连真邮局。 */
  inbox?: boolean;
  /** 真机：Ctrl+R = 编译源码 + 整程序重开。自测模式传 false，只刷新面板，别把测试进程干掉。 */
  liveRestart?: boolean;
}

/** 装配口：注册 IPC（+ 可选热键、常驻显示）。书签台的任何失败在这里被吞掉记日志，不许往外炸。 */
export function initBookmarkPanel(options?: BookmarkPanelOptions): void {
  if (store) return;
  store = new BookmarkStore();
  roster = new AgentRoster();
  // 一条一份小文件（设定24）：每次存盘后对齐一次，开机先对齐一次。
  store.onSaved = scheduleItemFileSync;
  scheduleItemFileSync();
  liveRestart = Boolean(options?.liveRestart);
  // 启动 Agent 真打开桌面快捷方式只在真机。验证脚本不带自测开关（照样常驻），靠 isIsolatedRun 认出来（同 pet/focus-agent）。
  // 2026-09-24 踩过：只看常驻，验证脚本跑一次开一个真 Claude 窗口。
  // 🚨 别再拿 AGENT_PET_HUB_HOME 判：两套共用数据时真机也设它，10-22 起真机六个点开不了 Agent（10-24 修）。
  openAgents = Boolean(options?.resident) && !isIsolatedRun();
  hoverFocusEnabled = openAgents;
  registerIpc();
  if (options?.hotkey) registerHotkey();
  if (options?.inbox) {
    // 收信模块：坏了只记日志不连坐（隔离铁律）；连不上邮局会自己指数退避重连。
    try {
      ensureBookmarkInboxStarted({ store: requireStore(), onInboxChanged: notifyInboxChanged, cursorPath: join(bookmarkDataDirectory(), "inbox-cursor.json") });
      // 手机同步（设定19）：整板变了就抄一份发到中转站，手机打开就拉最新一份。发不出去只记日志。
      const config = readInboxConfig();
      if (config) {
        startBoardPublisher({
          server: config.server,
          user: config.user,
          pass: config.pass,
          topic: config.boardTopic,
          snapshot: () => buildBoardSnapshot(requireStore().list(), requireRoster().list(), readBoardMode(), Date.now(), readProjectsForPhone()),
        });
      }
    } catch (error) {
      log.出事("收信模块启动失败（看板仍可用，只是收不到手机消息）", error, "inbox");
    }
  }
  if (options?.resident && !isIsolatedRun()) {
    startOrganizerTimer();
    startIdleOrganizer();
  }
  if (options?.resident) {
    try {
      const win = ensurePanel();
      // 页面还没加载完：记下「加载完就显示」。以前漏了这一笔，开机每次都干等 6 秒兜底才出来（2026-10-24 修）。
      // 🚨 验证脚本（isIsolatedRun）照旧等 6 秒兜底：一加载完就显示的话测试窗口马上沉到真桌面底下，
      // carry、drag-bundle、titles 截图常卡死（对照实测 6 次过 3 次 vs 不改 6 次过 5 次），原因没挖到底。
      if (rendererReady) showDocked(win);
      else if (!isIsolatedRun()) pendingShow = true;
      startSinkTimer();
    } catch (error) {
      log.出事("书签台常驻显示失败（不影响桌宠本体）", error, "init");
    }
  }
  // CLI 接入服务（2026-09-10 拍板）：本机回环小服务，AI agent 用命令行读写看板。本地功能跟邮局无关，testMode 也照常起。
  try {
    startBookmarkCliServer({
      store: {
        add: (input) => bookmarkCliAdd(input),
        list: () => bookmarkCliList(),
        remove: (id) => bookmarkCliRemove(id),
        // 领活三件套（设定15）：跟看板同一个 store，AI 领了/干完看板马上刷新。
        claimNext: (target, by) => requireStore().claimNext(target, by),
        // 派活单（设定23）：强模型一次写 1～3 张；没说组默认 Pi 组（2026-10-15 用户：派我主要就是让它干这个）。
        addDispatchBatch: (cards) => requireStore().addDispatchBatch(cards.map((c) => ({ ...c, assignee: resolveGroup(c.assignee) }))),
        itemFile: (id) => itemFileFor(id),
        // 命令行 launch（2026-10-16）：调度说「直接开」时替用户点一键启动，跟六个点同一份
        launchBatch: (id, coding, model) => launchDispatchBatch(id, coding, model),
        piModels: () => readPiModels(),
        done: (id, by, userOk) => {
          const record = requireStore().done(id, by, userOk);
          log.记(`${by} 干完删掉「${record.text.slice(0, 30)}」（用户原话：${userOk.slice(0, 60)}）`, "cli");
          return record;
        },
        release: (id) => requireStore().release(id),
        // 睡觉档（设定18）：按组领、干完写大白话报告、告诉 AI 现在是哪一档。
        claimInGroup: (group, by) => requireStore().claimInGroup(group, by),
        report: (id, by, text) => {
          const record = requireStore().report(id, by, text);
          log.记(`${by} 睡觉档干完「${record.text.slice(0, 30)}」，报告挂上等用户审`, "cli");
          return record;
        },
        dispatch: (input) => handleDispatchAction(requireStore(), input),
        bundleInfo: (id) => requireStore().taskBundles().find(b => b.id === id),
        // 按号码读（2026-10-13）：组名单、小标题、捆名都跟看板上显示的同一份。
        boardNames: () => {
          const titles: Record<string, string> = {};
          for (const [id, note] of Object.entries(readNoteBook())) if (note.title) titles[id] = note.title;
          const bundleNames: Record<string, string> = {};
          for (const [id, meta] of Object.entries(requireStore().bundleMeta())) if (meta.name) bundleNames[id] = meta.name;
          for (const b of requireStore().taskBundles()) if (b.coordinator) bundleNames[b.id] = `派工捆 · ${b.name}`;
          return { agents: requireRoster().list(), titles, bundleNames, itemFile: (id: string) => itemFileFor(id) };
        },
        mode: () => readBoardMode(),
        template: () => listTemplates(templatesDirectory()).find((t) => t.name === CODING_TEMPLATE)?.text ?? null,
      },
      onChanged: notifyInboxChanged,
    });
  } catch (error) {
    log.出事("CLI 接入服务启动失败（看板仍可用，只是命令行连不上）", error, "cli");
  }
  log.记("书签台就绪（Agent 看板·常驻贴屏）", "init");
}

/** 托盘入口（app.ts 注入 pet 托盘）：看板已永远常驻显示，这里的「打开」= F1 同款置顶开关
 *  （提上来好看见，再点一下沉回去）。旧的显示/收起 toggle 已随 F3 一起撤（改版三）。 */
export function toggleBookmarkPanel(): void {
  try {
    const win = ensurePanel();
    // 常驻不该隐藏；万一处于隐藏态先拉回来，别让托盘点了没反应。
    if (!win.isVisible()) showDocked(win);
    toggleBoardPin();
  } catch (error) {
    log.出事("书签台置顶开关失败（托盘入口）", error, "toggle");
  }
}

/** 退出清理：退热键、停定时器、关窗口。数据在磁盘上，不丢。 */
export function closeBookmarkPanel(): void {
  panelShuttingDown = true;
  try {
    if (hotkeyRegistered) {
      globalShortcut.unregister(BOOKMARK_HOTKEY);
      hotkeyRegistered = false;
    }
  } catch (error) {
    log.出事("书签台热键注销失败", error, "close");
  }
  try {
    if (sinkTimer) {
      clearInterval(sinkTimer);
      sinkTimer = null;
    }
  } catch (error) {
    log.出事("书签台沉底定时器清理失败", error, "close");
  }
  try {
    stopBookmarkInbox();
  } catch (error) {
    log.出事("收信模块停止失败", error, "close");
  }
  try {
    panel?.destroy();
  } catch (error) {
    log.出事("书签台窗口关闭失败", error, "close");
  }
  panel = null;
}

function registerHotkey(): void {
  if (hotkeyRegistered) return;
  try {
    const ok = globalShortcut.register(BOOKMARK_HOTKEY, toggleBoardPin);
    hotkeyRegistered = ok;
    if (ok) log.记(`全局热键已注册 ${BOOKMARK_HOTKEY}（置顶/沉底开关）`, "init");
    else log.出事(`全局热键 ${BOOKMARK_HOTKEY} 注册失败（被别的程序占了？看板仍常驻显示，置顶可从托盘开关）`, undefined, "init");
  } catch (error) {
    log.出事("热键注册异常（看板仍常驻显示，置顶可从托盘开关）", error, "init");
  }
}

function ensurePanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;
  panel = createPanel();
  startSinkTimer();
  return panel;
}

function createPanel(): BrowserWindow {
  rendererReady = false;
  const win = buildWindow();
  // 显示触发器双保险：ready-to-show 在开机早期（GPU 未热）可能不触发（改版二实测踩过），
  // did-finish-load 兑底；两个都触发也幂等（rendererReady/pendingShow 双闩）。
  const showWhenReady = (source: string): void => {
    if (rendererReady) return;
    rendererReady = true;
    log.记(`看板显示触发器：${source}`, "load");
    if (pendingShow) {
      pendingShow = false;
      try {
        showDocked(win);
      } catch (error) {
        log.出事("看板首次显示失败（强制 show 重试）", error, "load");
        try {
          win.show();
        } catch {
          /* 真没救了，留在隐藏态，托盘入口还能拉（托盘点击会兜底重 show） */
        }
      }
    }
  };
  win.once("ready-to-show", () => showWhenReady("ready-to-show"));
  win.webContents.once("did-finish-load", () => showWhenReady("did-finish-load"));
  win.webContents.on("did-start-loading", () => log.记("看板 load：did-start-loading", "load"));
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    log.出事(`看板 load 失败：${code} ${desc} ${url}`, undefined, "load"));
  win.webContents.on("render-process-gone", (_e, details) =>
    log.出事(`看板渲染进程挂了：${details.reason}`, undefined, "load"));
  win.webContents.on("did-finish-load", () => log.记("看板 load：did-finish-load", "load"));
  // 用户手动调大小 → 防抖存档（resize 事件拖动时连发，1.5 秒不动了才写盘）。
  // 首次建窗/显示触发的 resize 也会走这里——存的值跟启动尺寸一样，幂等无害。
  let resizeSaveTimer: NodeJS.Timeout | null = null;
  win.on("resize", () => {
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      resizeSaveTimer = null;
      try {
        if (!win.isDestroyed()) {
          const { width, height } = win.getBounds();
          writeSavedWindowSize({ width, height });
        }
      } catch (error) {
        log.出事("看板尺寸存档失败（不影响使用）", error, "window");
      }
    }, RESIZE_SAVE_DEBOUNCE_MS);
  });
  // 失焦即沉底：用户点去别的窗口，看板立刻退到所有窗口之下，绝不挡人。
  win.on("blur", () => {
    // F1 置顶着、用户点了看板外面别处 → 收起置顶沉回最底（2026-10-13 用户：只有点别处才收，鼠标动不算）。
    if (!win.isDestroyed() && win.isVisible()) {
      if (pinnedTopmost) toggleBoardPin();
      else sinkToBottom(win);
    }
    // 等 Windows 自己那一下「变灰」处理完再补发，不然会被它盖回去。
    setTimeout(() => keepAcrylicLit(win), 0);
  });
  win.on("show", () => setTimeout(() => keepAcrylicLit(win), 0));
  wireBoardZoom(win);
  // 🚨 看板永远常驻（设定03）。窗口被意外关掉（Alt+F4、系统收走）就记一笔，1 秒后重建；
  // 只有退出程序走 closeBookmarkPanel 才算真关。2026-10-01 实机：窗口没了、日志一个字没有，托盘点了才回来。
  win.on("closed", () => {
    if (panel === win) panel = null;
    if (panelShuttingDown) return;
    log.出事("看板窗口被关了（不是退出程序），1 秒后重建", undefined, "window");
    setTimeout(() => {
      if (panelShuttingDown || panel) return;
      try {
        ensurePanel();
      } catch (error) {
        log.出事("看板重建失败（托盘「书签台」还能拉回来）", error, "window");
      }
    }, 1_000);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 面板里不开网页：链接一律丢给系统浏览器。
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadFile(join(__dirname, "renderer", "index.html"), { query: { v: PANEL_VERSION } })
    .then(() => log.记(`看板 loadFile promise 完成（版本 ${PANEL_VERSION}）`, "load"))
    .catch((error) => log.出事("看板 loadFile 失败", error, "load"));
  // 6 秒兜底：加载事件全都不到场（开机早期渲染器冻结实测过）就强制 show 逼它动。
  setTimeout(() => {
    try {
      if (!win.isDestroyed() && !win.isVisible()) {
        log.出事("看板 6 秒未显示，强制 show 兑底", undefined, "load");
        showDocked(win);
      }
    } catch (error) {
      log.出事("看板 6 秒兑底失败", error, "load");
    }
  }, 6_000);
  return win;
}

function buildWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea;
  // 有存档用存档宽高（换屏超界由 computeDockedBounds 夹住），没有用用户拍板的默认尺寸。
  const bounds = computeDockedBounds(workArea, readSavedWindowSize() ?? DEFAULT_PANEL_SIZE);
  const base = {
    ...bounds,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundThrottling: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 🚨 常驻沉底窗口：默认不置顶（Electron alwaysOnTop 层级是桌宠窗口的，抢层级会打架）。
    // F1 置顶走 SetWindowPos(HWND_TOPMOST)，不碰 alwaysOnTop 状态（改版三）。
    alwaysOnTop: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  try {
    // Win11 毛玻璃；构造参数不认这个材质的系统直接走回落。
    const win = new BrowserWindow({ ...base, backgroundMaterial: "acrylic" });
    log.记(`面板已建（acrylic 毛玻璃·贴右缘 ${bounds.width}×${bounds.height}）`, "window");
    return win;
  } catch (error) {
    log.出事("acrylic 毛玻璃不可用，回落无材质半透明", error, "window");
    return new BrowserWindow(base);
  }
}

/** 常驻显示：先试不抢焦点的 showInactive；500ms 后还没亮就用 show() 强制（首次亮窗实测需要）。 */
function showDocked(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.showInactive();
  setTimeout(() => {
    try {
      if (!win.isDestroyed() && !win.isVisible()) {
        log.记("showInactive 未生效，改用 show() 强制显示", "window");
        win.show();
      }
      sinkToBottom(win);
    } catch (error) {
      log.出事("看板显示兑底失败", error, "window");
    }
  }, 500);
}

/** 沉底兜底定时器：失焦事件之外，没聚焦就压底（盖住 resize/拖动等遗漏场景）。 */
function startSinkTimer(): void {
  if (sinkTimer) return;
  sinkTimer = setInterval(() => {
    try {
      if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
      if (panel.isFocused()) return; // 用户正在面板里打字/点击，不许压到看不见。
      // F1 置顶期间不压：对置顶窗口发 HWND_BOTTOM 会把置顶摘掉直接沉底（微软 SetWindowPos 文档原话），
      // 2026-10-13 前就是这一下让「F1 提上来，鼠标一动就没了」——其实是这 2 秒定时器。置顶只有点别处或再按 F1 才收。
      if (pinnedTopmost) return;
      sinkToBottom(panel);
    } catch (error) {
      log.出事("沉底兜底检查失败（不影响使用）", error, "timer");
    }
  }, SINK_TIMER_MS);
  sinkTimer.unref();
}

/** 源码夹里最新一份文件的改动时间。只扫 src，不扫 node_modules。 */
function latestSourceTime(): number {
  const root = join(app.getAppPath(), "src");
  let latest = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_old") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stamp = statSync(full).mtimeMs;
        if (stamp > latest) latest = stamp;
      } catch {
        // 单个文件读失败不影响整次比对
      }
    }
  };
  walk(root);
  return latest;
}

type RelaunchResult = { ok: boolean; mode: "relaunch"; error?: string };
/** 正在编译的那一次：编译中再按 Ctrl+R（看板、桌宠哪个窗口按的都算）接着等这一次，不另起一遍。 */
let rebuilding: Promise<RelaunchResult> | null = null;

/**
 * 编译当前源码再整程序重开（Ctrl+R，看板和桌宠小窗口都走这里）。失败不重开，把原因交回面板。
 * 2026-10-24 改成后台编译：以前同步等编译，那几秒整个桌宠（看板、气泡）都卡死，按键还攒着一起来。
 * 进度一律发到看板（bookmark:reload-progress），桌宠小窗口按的也在看板上提示。
 */
export function relaunchWithNewCode(): Promise<RelaunchResult> {
  if (!liveRestart) return Promise.resolve({ ok: false, mode: "relaunch", error: "测试实例不重开" });
  if (!rebuilding) rebuilding = rebuildAndRelaunch().finally(() => { rebuilding = null; });
  return rebuilding;
}

function sendReloadProgress(text: string, ms: number): void {
  try {
    if (panel && !panel.isDestroyed()) panel.webContents.send("bookmark:reload-progress", { text, ms });
  } catch {
    /* 看板不在就算了 */
  }
}

async function rebuildAndRelaunch(): Promise<RelaunchResult> {
  const appRoot = app.getAppPath();
  log.记(`Ctrl+R：开始编译源码（${appRoot}）`, "reload");
  sendReloadProgress("正在升级成最新代码…（编译几秒，期间照常能用）", 30_000);
  // 2026-10-24 改成「升级」：拿桌宠自带的 electron.exe 当 node 跑（ELECTRON_RUN_AS_NODE），不靠电脑上碰巧装的 node / npm
  // （根这边只有 Hermes 带的 node 22.23，碰中文路径就崩）。upgrade-build.mjs 先编到新夹，编成功才换 dist，失败旧的照用。
  const bundled = join(appRoot, "node_modules", "electron", "dist", "electron.exe");
  const nodeExe = existsSync(bundled) ? bundled : process.execPath;
  const args = [join(appRoot, "scripts", "upgrade-build.mjs")];
  const result = await new Promise<{ status: number | null; output: string; error?: Error }>((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nodeExe, args, { cwd: appRoot, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    } catch (error) {
      resolve({ status: null, output: "", error: error as Error });
      return;
    }
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, output, error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
  if (result.status !== 0) {
    const detail = result.output.trim();
    log.出事(`Ctrl+R 编译失败（status=${result.status}）`, detail || result.error, "reload");
    sendReloadProgress("升级失败：编译没过，旧代码照常在用（原因在桌宠日志 bookmark 那份）", 12_000);
    return { ok: false, mode: "relaunch", error: detail.slice(-500) || "编译失败" };
  }
  const relaunchArgs = process.argv.slice(1).filter((item) => item !== RELAUNCH_FLAG).concat(RELAUNCH_FLAG);
  log.记(`Ctrl+R：编译完成，整程序重开（${result.output.trim().split(/\r?\n/).pop() || ""}）`, "reload");
  sendReloadProgress("编译好了，马上重开…", 5_000);
  app.relaunch({ args: relaunchArgs });
  app.quit();
  return { ok: true, mode: "relaunch" };
}

function registerIpc(): void {
  registerBookmarkImageIpc((sender) => Boolean(panel && !panel.isDestroyed() && sender === panel.webContents));
  ipcMain.handle("bookmark:list", () => requireStore().list());
  ipcMain.handle('bookmark:dispatch', (_event, input) => {
    const result = handleDispatchAction(requireStore(), input ?? {});
    if (!['list', 'messages', 'skills', 'skill'].includes(String(input?.action))) notifyInboxChanged();
    return result;
  });
  const skillRoot = join(__dirname, '..', '..', 'skills（AI用看板的说明书）');
  ipcMain.handle('bookmark:skills:list', () => listBoardSkills(skillRoot));
  ipcMain.handle('bookmark:skills:read', (_event, name) => readBoardSkill(skillRoot, String(name ?? '')));
  ipcMain.handle('bookmark:dispatch:copy', (_event, payload) => {
    const raw = payload ?? {};
    const bundle = requireStore().taskBundles().find(b => b.id === String(raw.id ?? ''));
    if (!bundle) throw new Error('找不到协同捆');
    const worker = String(raw.by ?? '').trim();
    if (!worker || /["\r\n]/.test(worker)) throw new Error('填写独立执行窗口的名字');
    const text = `先读看板派工技能：${join(skillRoot, 'Agent看板', '看板派工.md')}\n只领本捆，用户自己开窗口，不要开子助手：\nnode "${bookmarkCliScriptPath()}" next ${bundle.id} --by "${worker}"`;
    clipboard.writeText(text);
    return text;
  });
  // 撤回账（2026-10-13）：看板上用户的动作一律过 userAction，Ctrl+Z 能退回；AI 整理、命令行、手机来的不记。
  const act = <T>(label: string, fn: () => T, keyOf?: (result: T) => string | null): T => requireStore().userAction(label, fn, keyOf);
  const textKey = (r: BookmarkRecord | null) => (r ? `text:${r.id}` : null);
  ipcMain.handle("bookmark:undo", () => {
    const label = requireStore().undo();
    if (label) notifyInboxChanged();
    return label;
  });
  ipcMain.handle("bookmark:add", (_event, input: unknown) => act("新写一条", () => requireStore().add(normalizeInput(input)), textKey));
  ipcMain.handle("bookmark:insert-beside", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { anchorId?: unknown; place?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    const anchorId = raw.anchorId ? String(raw.anchorId) : null;
    return act("新写一条", () => requireStore().insertBeside(anchorId, place, normalizeInput(payload)), textKey);
  });
  ipcMain.handle("bookmark:move", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; anchorId?: unknown; place?: unknown; into?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    const into = raw.into === null ? null : typeof raw.into === "string" && raw.into ? raw.into : undefined;
    return act("挪动一条", () => requireStore().move(String(raw.id ?? ""), String(raw.anchorId ?? ""), place, into));
  });
  // 跨组一步到位（2026-10-13 拖动和剪切粘贴）。
  ipcMain.handle("bookmark:relocate", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; assignee?: unknown; anchorId?: unknown; place?: unknown; into?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    const into = raw.into === null ? null : typeof raw.into === "string" && raw.into ? raw.into : undefined;
    const assignee = typeof raw.assignee === "string" && raw.assignee ? raw.assignee : null;
    const anchorId = typeof raw.anchorId === "string" && raw.anchorId ? raw.anchorId : null;
    return act("挪到别的组", () => requireStore().relocate(String(raw.id ?? ""), assignee, anchorId, place, into));
  });
  // 整捆搬家（2026-10-13）：带了 assignee 才换组。
  ipcMain.handle("bookmark:move-bundle", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { bundleId?: unknown; assignee?: unknown; anchorId?: unknown; place?: unknown };
    const assignee = !("assignee" in raw) ? undefined : typeof raw.assignee === "string" && raw.assignee ? raw.assignee : null;
    const anchorId = typeof raw.anchorId === "string" && raw.anchorId ? raw.anchorId : null;
    return act("搬整捆", () => requireStore().moveBundle(String(raw.bundleId ?? ""), assignee, anchorId, raw.place === "below" ? "below" : "above"));
  });
  // 批量剪切（2026-10-27）：Ctrl 点选的几条一起放下，一个 act 里挪完，Ctrl+Z 一步全回去。
  ipcMain.handle("bookmark:move-many", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { ids?: unknown; assignee?: unknown; anchorId?: unknown; place?: unknown; into?: unknown; bundleWith?: unknown };
    const ids = Array.isArray(raw.ids) ? raw.ids.map((x) => String(x)) : [];
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return act(`挪 ${ids.length} 条`, () => requireStore().moveMany(ids, {
      assignee: str(raw.assignee),
      anchorId: str(raw.anchorId),
      place: raw.place === "below" ? "below" : "above",
      into: str(raw.into),
      bundleWith: str(raw.bundleWith),
    }));
  });
  // 交给哪套系统（2026-10-27）：右键改，空＝不标。
  ipcMain.handle("bookmark:set-for-system", (_event, payload: unknown) => {
    const { id, name } = (payload ?? {}) as { id?: unknown; name?: unknown };
    return act("改交给谁", () => requireStore().setForSystem(String(id ?? ""), typeof name === "string" ? name : null));
  });
  ipcMain.handle("bookmark:remove", (_event, id: unknown) => act("删掉一条", () => requireStore().remove(String(id))));
  // 大标题右键「删除这一捆」（2026-10-16）：整捆在一步里删，Ctrl+Z 一步全回来
  ipcMain.handle("bookmark:remove-bundle", (_event, bundleId: unknown) => act("删掉一捆", () => {
    const ids = requireStore().list().filter((r) => r.bundleId === String(bundleId ?? "")).map((r) => r.id);
    for (const id of ids) requireStore().remove(id);
    return ids.length;
  }));
  ipcMain.handle(
    "bookmark:set-assignee",
    (_event, payload: unknown) => {
      const { id, assignee } = (payload ?? {}) as { id?: unknown; assignee?: unknown };
      return act("改派", () => requireStore().setAssignee(String(id), assignee == null || assignee === "" ? null : String(assignee)));
    },
  );
  // 输入行自动存档（2026-09-11 改版三）：草稿入库后边写边改同一条（renderer 防抖 400ms + 失焦必落盘，写了就是写了）。
  ipcMain.handle(
    "bookmark:update-text",
    (_event, payload: unknown) => {
      const { id, text, url } = (payload ?? {}) as { id?: unknown; text?: unknown; url?: unknown };
      return act("改字", () => requireStore().updateText(String(id), String(text ?? ""), url ? String(url) : null), textKey);
    },
  );
  ipcMain.handle("bookmark:update-detail", (_event, payload: unknown) => {
    const { id, detail } = (payload ?? {}) as { id?: unknown; detail?: unknown };
    return act("改详情", () => requireStore().updateDetail(String(id ?? ""), String(detail ?? "")), (r) => (r ? `detail:${r.id}` : null));
  });
  // 旧 bookmark:hide（收起面板）已随 F3 一起撤（改版三：看板永远常驻显示）。
  // 局部 Ctrl+R（面板内监听，🚨 不准改成 globalShortcut——全局会拦掉其他软件的 Ctrl+R）。
  // 真机：编译源码 + 整程序重开（跟脑图设定11同一套，等几秒正常）。自测：只刷新面板。
  ipcMain.handle("bookmark:reload", () => {
    if (!liveRestart) {
      if (panel && !panel.isDestroyed()) panel.webContents.reload();
      return { ok: true, mode: "reload" as const };
    }
    return relaunchWithNewCode();
  });
  ipcMain.handle("bookmark:code-status", () => {
    const codeAt = latestSourceTime();
    return {
      startedAt: PROCESS_STARTED_AT,
      codeAt,
      stale: codeAt > PROCESS_STARTED_AT + 2000,
    };
  });

  // ── Agent 看板分组（2026-09-10 改版）：分组清单独立存 agents.json ──
  ipcMain.handle("bookmark:agents", () => requireRoster().list());
  // 「更多 Agent」折叠区（2026-10-27）：收了哪几组、展开没有，存 agents-fold.json
  ipcMain.handle("bookmark:fold", () => requireRoster().fold());
  ipcMain.handle("bookmark:fold:open", (_event, open: unknown) => requireRoster().setFoldOpen(Boolean(open)));
  ipcMain.handle("bookmark:fold:set", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { name?: unknown; on?: unknown };
    return requireRoster().setFolded(String(raw.name ?? ""), Boolean(raw.on));
  });
  // 外观设置（透明度）：读用在面板首渲染前，写由滑条防抖调（存 appearance.json）。
  ipcMain.handle("bookmark:appearance:get", () => readBoardOpacity());
  ipcMain.handle("bookmark:appearance:set", (_event, opacity: unknown) => writeBoardOpacity(Number(opacity)));
  // ── 📁 项目文件夹（2026-09-11 拍板）：真实文件夹+真实 md，存 bookmark\projects\；open 走系统默认程序 ──
  ipcMain.handle("bookmark:projects:list", (_event, relative: unknown) => {
    ensureProjectsRoot();
    return listProjects(projectsRoot(), String(relative ?? ""));
  });
  ipcMain.handle("bookmark:projects:mkdir", (_event, payload: unknown) => {
    const { parent, name } = (payload ?? {}) as { parent?: unknown; name?: unknown };
    ensureProjectsRoot();
    return createProjectFolder(projectsRoot(), String(parent ?? ""), String(name ?? ""));
  });
  ipcMain.handle("bookmark:projects:touch", (_event, payload: unknown) => {
    const { parent, name } = (payload ?? {}) as { parent?: unknown; name?: unknown };
    ensureProjectsRoot();
    return createProjectMarkdown(projectsRoot(), String(parent ?? ""), String(name ?? ""));
  });
  ipcMain.handle("bookmark:projects:reorder", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { parent?: unknown; moving?: unknown; anchor?: unknown; place?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    ensureProjectsRoot();
    return reorderProjects(projectsRoot(), String(raw.parent ?? ""), String(raw.moving ?? ""), String(raw.anchor ?? ""), place);
  });
  ipcMain.handle("bookmark:projects:open", async (_event, relative: unknown) => {
    // 先过安全闸（越界拒绝），再交系统默认程序（用户 md 关联了脑图应用）。
    ensureProjectsRoot();
    const abs = resolveProjectPath(projectsRoot(), String(relative ?? ""));
    const errorMessage = await shell.openPath(abs);
    if (errorMessage) throw new Error(`打不开：${errorMessage}`);
    return true;
  });
  // 复制给 AI（2026-09-24）：模板夹一份 md = 气泡一项；拼好直接进剪贴板，用户自己粘、自己发（不替他开窗、不替他发）。
  ipcMain.handle("bookmark:templates", () => listTemplates(templatesDirectory()).map((t) => t.name));
  ipcMain.handle("bookmark:copy-for-agent", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; template?: unknown };
    const record = requireStore().list().find((r) => r.id === String(raw.id ?? ""));
    if (!record) throw new Error("这条已经不在了");
    const name = typeof raw.template === "string" ? raw.template : null;
    const template = name ? listTemplates(templatesDirectory()).find((t) => t.name === name) : null;
    if (name && !template) throw new Error(`要求模板「${name}」找不到了`);
    const text = composeForAgent(template ? template.text : null, record);
    clipboard.writeText(text);
    return text;
  });
  // 右键「捆成一捆」（设定21）：看板上手动捆的，以最后一次为准，AI 以后不碰这几条。
  ipcMain.handle("bookmark:bundle-selected", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { ids?: unknown; name?: unknown };
    const ids = Array.isArray(raw.ids) ? raw.ids.map((x) => String(x ?? "")) : [];
    return act("捆成一捆", () => requireStore().createTaskBundle(ids, String(raw.name ?? "")));
  });
  ipcMain.handle("bookmark:bundle-meta", () => requireStore().bundleMeta());
  // AI 整理（设定21）：设置窗口读写、手动整理一次、全部重来 / 撤销、提示「知道了」。钥匙不回给界面，只说有没有。
  ipcMain.handle("bookmark:organizer:get", () => organizerStatus());
  // 设置窗口点「保存」一次交一整份；只改传了的项。规矩改成跟默认一样＝删掉自己的那份，回到默认。
  ipcMain.handle("bookmark:organizer:set", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { current?: unknown; enabled?: unknown; intervalHours?: unknown; effort?: unknown; rules?: unknown; checkRules?: unknown };
    const config = readOrganizerConfig();
    if (typeof raw.current === "string" && config.models.some((m) => m.id === raw.current)) config.current = raw.current;
    if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
    if (raw.intervalHours !== undefined) {
      const hours = Number(raw.intervalHours);
      if (!Number.isFinite(hours) || hours < 0.25 || hours > 48) throw new Error("隔多久整理：填 0.25 到 48 小时");
      config.intervalHours = hours;
    }
    if (typeof raw.effort === "string") {
      if (!EFFORTS.includes(raw.effort as Effort)) throw new Error("思考档位只认 low / high / max");
      config.effort = raw.effort as Effort;
    }
    if (typeof raw.rules === "string") writeRulesFile(ORGANIZER_RULES_FILE, raw.rules, ORGANIZER_RULES);
    if (typeof raw.checkRules === "string") writeRulesFile(CHECK_RULES_FILE, raw.checkRules, CHECK_RULES);
    const intervalChanged = config.intervalHours !== readOrganizerConfig().intervalHours;
    writeOrganizerConfig(config);
    if (intervalChanged && organizerTimer) {
      clearTimeout(organizerTimer);
      startOrganizerTimer(config.intervalHours * 3600_000);
    }
    return organizerStatus();
  });
  // 模型（2026-10-12 用户：换别家 AI 也能加）：加、改、删马上存（钥匙不该在界面里留着等「保存」）。
  ipcMain.handle("bookmark:organizer:model", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { action?: unknown; id?: unknown; provider?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown };
    const config = readOrganizerConfig();
    const id = String(raw.id ?? "");
    if (raw.action === "add") {
      const v = checkModelInput(raw, true);
      const entry = { id: `m-${Date.now().toString(36)}`, ...v };
      config.models.push(entry);
      config.current = entry.id;
    } else if (raw.action === "update") {
      const entry = config.models.find((m) => m.id === id);
      if (!entry) throw new Error("这个模型已经没了");
      const v = checkModelInput(raw, false);
      Object.assign(entry, { provider: v.provider, baseUrl: v.baseUrl, model: v.model }, v.apiKey ? { apiKey: v.apiKey } : {});
    } else if (raw.action === "remove") {
      if (config.models.length <= 1) throw new Error("至少留一个模型");
      config.models = config.models.filter((m) => m.id !== id);
      if (config.current === id) config.current = config.models[0].id;
    } else {
      throw new Error("不认识的操作");
    }
    writeOrganizerConfig(config);
    return organizerStatus();
  });
  // 「测一下」：表里填的（钥匙留空就用这个模型存着的那把）发一句最短的话。
  ipcMain.handle("bookmark:organizer:test-model", async (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; provider?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown };
    const saved = readOrganizerConfig().models.find((m) => m.id === String(raw.id ?? ""));
    const v = checkModelInput({ ...raw, apiKey: String(raw.apiKey ?? "").trim() || saved?.apiKey || "" }, true);
    try {
      const reply = await testModel({ id: "test", ...v }, organizerFetch);
      return { ok: true, text: `通了，它回：${reply}` };
    } catch (error) {
      return { ok: false, text: `没通：${error instanceof Error ? error.message : error}` };
    }
  });
  // 规矩页（设定21）：看板里所有给 AI 的规矩摆在一处，用户能看、整理 / 检查规矩能改，别的只读并说清在哪改。
  ipcMain.handle("bookmark:board-rules", () => boardRulesList(skillRoot));
  // 账本（设定21）：跟着看板现算，条目删了账本里也就没了。
  ipcMain.handle("bookmark:organizer:ledger", () => buildLedger(requireStore().list(), requireRoster().list(), requireStore().bundleMeta(), readRunRecords()));
  // 整理记录：一行一件事，理由放气泡。
  ipcMain.handle("bookmark:organizer:records", () => readRunRecords());
  // 看板上的小橙点：条目 id → 提示。
  ipcMain.handle("bookmark:organizer:hints", () => readHintBook().hints);
  // 每条的小标题（第五版）：板上第一行显示。只给还作数的（读完没改过的）。
  // 搜看板（2026-10-27 用户：说一句「Agent看板」，把这摊活全拉出来）：先按字找，再让整理用的小模型从认出的项目名里挑同一个东西。
  // 小模型没配、不通，就只给按字找到的，并说一声。
  // 找分两段（2026-10-27 用户：快，但质量不能降）：part=fast 只按字找＋按意思找（2 秒内），part=projects 只让小模型认项目名（慢）；
  // 界面两段一起发，先回来的先选中，后回来的补上，三路结果跟一次全等完一样。不带 part（老写法）＝三路都等完再回。
  ipcMain.handle("bookmark:search", async (_event, payload: unknown) => {
    const raw = (typeof payload === "object" && payload ? payload : { query: payload }) as { query?: unknown; part?: unknown };
    const part = raw.part === "fast" || raw.part === "projects" ? raw.part : "all";
    const q = String(raw.query ?? "").trim().slice(0, 40);
    if (!q) return { ids: [], projects: [], modelError: null, byMeaning: 0, vectorError: null };
    const records = requireStore().list();
    const book = readNoteBook();
    const ids = new Set(part === "projects" ? [] : searchByText(records, book, q));
    let projects: string[] = [];
    let modelError: string | null = null;
    const meaning = part === "projects" ? Promise.resolve({ found: [] as string[], error: null as string | null })
      : vectorSearch(q).then((found) => ({ found, error: null as string | null }),
        (error: unknown) => ({ found: [] as string[], error: error instanceof Error ? error.message : String(error) }));
    if (part !== "fast") {
      try {
        projects = await askSearchProjects(q, knownProjects(book), readOrganizerConfig(), organizerFetch);
        const keys = new Set(projects.map(projectKey));
        for (const r of records) if (keys.has(projectKey(book[r.id]?.project))) ids.add(r.id);
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
    }
    const { found, error: vectorError } = await meaning;
    const live = new Set(records.map((r) => r.id));
    const byMeaning = found.filter((id) => live.has(id) && !ids.has(id));
    for (const id of byMeaning) ids.add(id);
    if (vectorError) log.出事("看板按意思找没连上（按字找照常）", vectorError, "search");
    return { ids: [...ids], projects, modelError, byMeaning: byMeaning.length, vectorError };
  });
  ipcMain.handle("bookmark:organizer:notes", () => {
    const records = requireStore().list();
    const book = readNoteBook();
    // 读完没改过的给新的；改过、或规矩改了正在重读的，先给旧的顶着（stale），别让板上露回原文、样子不统一。
    const out: Record<string, { project: string; title: string; stale: boolean }> = {};
    for (const r of records) {
      const n = book[r.id];
      if (n) out[r.id] = { project: n.project, title: n.title, stale: !freshNote(r, book) };
    }
    return out;
  });
  ipcMain.handle("bookmark:organizer:dismiss", (_event, itemId: unknown) => {
    const id = String(itemId ?? "");
    const book = readHintBook();
    const hint = book.hints.find((h) => h.itemId === id);
    if (hint) {
      book.hints = book.hints.filter((h) => h.itemId !== id);
      book.dismissed.push({ itemId: id, placement: hint.placement });
      writeHintBook(book);
    }
    return book.hints;
  });
  // 全部重来：先存原样，所有捆拆开（你动过的也一样），然后马上整理＋检查。
  ipcMain.handle("bookmark:organizer:reset", async () => {
    if (organizerRunning) throw new Error("正在整理，等这一轮完了再点");
    const split = requireStore().aiResetAll();
    try {
      copyFileSync(hintBookPath(), `${hintBookPath()}.before-reset`);
    } catch {
      rmSync(`${hintBookPath()}.before-reset`, { force: true }); // 原来没有提示本，撤销时也就没有
    }
    writeHintBook({ hints: [], dismissed: [], checked: {} });
    writeNoteBook({}); // 全部重来＝每条也重读、小标题重写
    writeNameBook({}); // 捆名也全部重写
    log.记(`AI 整理全部重来：拆了 ${split} 个捆`, "organizer");
    notifyInboxChanged();
    await runOrganizerOnce("全部重来", [{ group: "全部", action: "全部重来", title: `全部重来：拆了 ${split} 个捆，所有条目重新整理`, why: "你点了「全部重来」。重来前的样子存着，下一次整理之前能撤销", itemIds: requireStore().list().map((r) => r.id) }]);
    return organizerStatus();
  });
  ipcMain.handle("bookmark:organizer:undo-reset", () => {
    if (organizerRunning) throw new Error("正在整理，等这一轮完了再点");
    const n = requireStore().undoReset();
    const saved = `${hintBookPath()}.before-reset`;
    if (existsSync(saved)) renameSync(saved, hintBookPath());
    else writeHintBook({ hints: [], dismissed: [], checked: {} });
    appendRunRecord({ at: new Date().toISOString(), model: "", rows: [{ group: "全部", action: "撤销重来", title: `撤销重来：${n} 条回到原来的样子`, why: "你点了「撤销重来」", itemIds: requireStore().list().map((r) => r.id) }] });
    log.记(`撤销全部重来：搬回 ${n} 条`, "organizer");
    organizerLast = { at: new Date().toISOString(), text: `撤销重来：${n} 条回到原样` };
    notifyInboxChanged();
    return organizerStatus();
  });
  ipcMain.handle("bookmark:organizer:run", async () => {
    await runOrganizerOnce("手动");
    return organizerStatus();
  });
  // 捆一捆 / 拆开 / 放回去（设定15）
  ipcMain.handle("bookmark:bundle", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; targetId?: unknown };
    return act("捆一捆", () => requireStore().bundleWith(String(raw.id ?? ""), String(raw.targetId ?? "")));
  });
  ipcMain.handle("bookmark:unbundle", (_event, bundleId: unknown) => act("拆开一捆", () => requireStore().unbundle(String(bundleId ?? ""))));
  ipcMain.handle("bookmark:release", (_event, id: unknown) => requireStore().release(String(id ?? "")));
  // 启动 Agent（设定15）：看板给这个窗口起名，拼一句「领看板的活」进剪贴板，再打开这个组对应的桌面快捷方式，
  // 新窗口启动好后替用户按一次 Ctrl+V。🚨 绝不替他按回车。开不了窗、贴不了只提示，照旧能手动来。
  ipcMain.handle("bookmark:launch-line", async (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { target?: unknown; group?: unknown; coding?: unknown; model?: unknown };
    const target = String(raw.target ?? "").trim();
    const group = String(raw.group ?? "").trim();
    if (!target || !group) throw new Error("缺条目或组名");
    // Pi 组挑了模型（2026-10-27）：跟一键启动一样，开窗前替他按一次 Ctrl+E；测试实例不碰真的 Pi 设置
    const model = raw.model && launchKey(group) === launchKey("Pi Agent") ? String(raw.model) : null;
    if (model) {
      if (openAgents || process.env.BOOKMARK_PI_SETTINGS) setPiModel(model);
      log.记(`启动 Agent：Pi 换成 ${model}（思考档开最高）`, "cli");
    }
    const label = nextWindowLabel(group);
    const line = `${LAUNCH_HEAD}node "${bookmarkCliScriptPath()}" next ${target} --by ${label}${raw.coding ? " --coding" : ""}`;
    clipboard.writeText(line);
    log.记(`启动 Agent：${label} ← ${target}${raw.coding ? "（带编程）" : ""}`, "cli");
    return { line, label, model, ...(await openAgentShortcut(group, line, label)) };
  });
  // 一键启动（设定23，2026-10-15）：这张派活单同批、还没人领的（最多三张），各开在自己所在组的软件里。
  // 一个接一个开：等上一个贴好再开下一个（同时开会贴串）。开之前查两张单子「只许动」有没有撞文件，撞了一个都不开。
  // 🚨 照旧只贴不按回车，回车用户自己按。
  ipcMain.handle("bookmark:launch-batch", async (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; coding?: unknown; model?: unknown };
    return launchDispatchBatch(String(raw.id ?? ""), Boolean(raw.coding), raw.model ? String(raw.model) : null);
  });
  // 一键启动菜单列 Pi 能挑的模型、默认选上次挑的那个（2026-10-16）
  ipcMain.handle("bookmark:hover-focus", () => hoverFocusBoard());
  ipcMain.handle("bookmark:hover-give-back", () => hoverGiveBack());
  ipcMain.handle("bookmark:pi-models", () => {
    try {
      return readPiModels();
    } catch {
      return { models: [], current: null };
    }
  });
  // 点号码（设定24）：复制这条那份单独小文件的路径，贴给 AI，它只读这一份。
  ipcMain.handle("bookmark:item-file", (_event, id: unknown) => {
    const record = requireStore().list().find((r) => r.id === String(id ?? ""));
    if (!record) throw new Error("这条已经不在了");
    const path = itemFileFor(record.id);
    const line = `看板${rowName(boardRows(), record)}的单独文件（只读这一份，别翻整组）：${path}`;
    clipboard.writeText(line);
    return { path, line };
  });
  // 按住序号拖出看板（2026-10-27 用户）：拖的就是这条的单独文件——放进 Claude Code 等窗口贴路径，放进文件夹复制一份
  ipcMain.on("bookmark:drag-out", (event, id: unknown) => {
    try {
      const path = itemFileFor(String(id ?? ""));
      if (!existsSync(path)) return;
      const icon = nativeImage.createFromPath(join(__dirname, "..", "assets", "app-icon.png")).resize({ width: 32, height: 32 });
      event.sender.startDrag({ file: path, icon });
    } catch (error) {
      log.出事("拖出看板失败（点序号照样能复制路径）", error, "window");
    }
  });
  // 大标题右键「复制路径」（2026-10-27 看板 01）：这一捆每条的单独文件一行一条，贴给 AI 只读这几份。
  ipcMain.handle("bookmark:bundle-files", (_event, bundleId: unknown) => {
    const rows = boardRows();
    const members = requireStore().list().filter((r) => r.bundleId === String(bundleId ?? ""));
    if (!members.length) throw new Error("这一捆已经不在了");
    const line = [`看板这一捆 ${members.length} 条的单独文件（只读这几份，别翻整组）：`, ...members.map((r) => `${rowName(rows, r)}：${itemFileFor(r.id)}`)].join("\n");
    clipboard.writeText(line);
    return { line, count: members.length };
  });
  // 两档仅决定领活后的报告流程；执行窗口一律由用户自己开，不挂自动开窗计时器。
  ipcMain.handle("bookmark:mode:get", () => readBoardMode());
  ipcMain.handle("bookmark:mode:set", (_event, value: unknown) => {
    const mode: BoardMode = value === "sleep" ? "sleep" : "day";
    writeJsonAtomic(join(bookmarkDataDirectory(), MODE_FILE), { mode });
    log.记(`看板切到${mode === "sleep" ? "睡觉档" : "日常档"}（不自动开助手窗口）`, "cli");
    return mode;
  });
  ipcMain.handle("bookmark:templates:open", async () => {
    const dir = templatesDirectory();
    mkdirSync(dir, { recursive: true });
    const errorMessage = await shell.openPath(dir);
    if (errorMessage) throw new Error(`打不开：${errorMessage}`);
    return true;
  });
  ipcMain.handle("bookmark:agents:move", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { name?: unknown; anchor?: unknown; place?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    return requireRoster().move(String(raw.name ?? ""), String(raw.anchor ?? ""), place);
  });
  ipcMain.handle("bookmark:agents:add", (_event, name: unknown) => requireRoster().add(String(name ?? "")));
  ipcMain.handle(
    "bookmark:agents:remove",
    (_event, name: unknown) => {
      const target = String(name ?? "").trim();
      const busy = requireStore().taskBundles().find(b => b.group.toLowerCase() === target.toLowerCase() && b.owner);
      if (busy) throw new Error(`「${busy.name}」由 ${busy.owner} 占住整捆，先放回再删除分组`);
      const removed = requireRoster().remove(target);
      // 名下条目不丢：全部收回待定（assignee 置空）。大小写不敏感对齐。
      if (removed) {
        for (const record of requireStore().list()) {
          if ((record.assignee ?? "").toLowerCase() === target.toLowerCase()) {
            requireStore().setAssignee(record.id, null);
          }
        }
      }
      return requireRoster().list();
    },
  );
}

function templatesDirectory(): string {
  return join(bookmarkDataDirectory(), "要求模板");
}

/** 「启动 Agent · 带编程」用的那份要求模板（要求模板夹里的 带编程.md）。 */
const CODING_TEMPLATE = "带编程";

/** 给 AI 用的命令脚本位置（正斜杠，哪种终端都能直接粘）。dist/bookmark/ → 仓库根/scripts/。 */
function bookmarkCliScriptPath(): string {
  return join(__dirname, "..", "..", "scripts", "bookmark-cli.mjs").split(String.fromCharCode(92)).join("/");
}

/** 贴字时机：每 200ms 看一眼谁在最前面，新窗口最多等 15 秒出来，出来后再等 4 秒让 AI 程序启动好。 */
const LAUNCH_PASTE_TIMING = { pollMs: 200, appearTimeoutMs: 15_000, settleMs: 4_000 };
/** 桌面程序：冷启动慢，最多等 30 秒跑到前面，再等 5 秒启动好；Ctrl+N 后等 1.5 秒新对话出来再贴。 */
const APP_PASTE_TIMING = { pollMs: 200, appearTimeoutMs: 30_000, settleMs: 5_000, newChatMs: 1_500 };

export interface BatchLaunchResult {
  launched: { name: string; label: string; opened: string; pasting: boolean }[];
  conflicts: { a: string; b: string; files: string[] }[];
  missing: string[];
  skipped: { name: string; reason: string }[];
  /** 这次替用户在 Pi 里换成的模型（没挑、这批没有 Pi 的单子就是 null）。 */
  model: string | null;
}

/**
 * 派活单一键启动（设定23）：同批没人领的一个接一个开，撞文件一个不开。看板六个点和命令行 launch 走的都是这一份。
 * model：这批里有 Pi 的单子才用——开窗前先替用户在 Pi 里「按一次 Ctrl+E」（pi-model.ts），三个窗口一起生效。
 */
async function launchDispatchBatch(id: string, coding: boolean, model: string | null): Promise<BatchLaunchResult> {
  const cards = requireStore().dispatchLaunchable(id);
  const rows = boardRows();
  const listed = cards.map((card) => ({ card, name: rowName(rows, card), files: parseAllowedFiles(`${card.text}\n${card.detail ?? ""}`) }));
  const missing = listed.filter((c) => c.files === null).map((c) => c.name);
  const conflicts = findFileConflicts(listed.map((c) => ({ name: c.name, files: c.files ?? [] })));
  const launched: BatchLaunchResult["launched"] = [];
  const skipped: BatchLaunchResult["skipped"] = [];
  if (conflicts.length) return { launched, conflicts, missing, skipped, model: null };
  const hasPi = listed.some(({ card }) => launchKey(card.assignee ?? "") === launchKey("Pi Agent"));
  const launchConfig = readLaunchConfig();
  let usedModel: string | null = null;
  if (model && hasPi) {
    // 测试实例（不真开窗）不碰真的 Pi 设置；验证脚本给了假设置文件才写
    if (openAgents || process.env.BOOKMARK_PI_SETTINGS) setPiModel(model);
    usedModel = model;
    log.记(`一键启动：Pi 换成 ${model}（思考档开最高）`, "cli");
  }
  for (const { card, name } of listed) {
    const group = card.assignee ?? "";
    if (!agentShortcutFor(group, launchConfig)) {
      skipped.push({ name, reason: "认不出这个组该开哪个软件" });
      continue;
    }
    const label = nextWindowLabel(group);
    const line = `${LAUNCH_HEAD}node "${bookmarkCliScriptPath()}" next ${card.id} --by ${label}${coding ? " --coding" : ""}`;
    clipboard.writeText(line);
    log.记(`一键启动：${label} ← ${card.id}${coding ? "（带编程）" : ""}`, "cli");
    const res = await openAgentShortcut(group, line, label, true);
    if (!res.opened) {
      skipped.push({ name, reason: res.problem ?? "没打开" });
      continue;
    }
    launched.push({ name, label, opened: res.opened, pasting: res.pasting });
  }
  return { launched, conflicts, missing, skipped, model: usedModel };
}

/**
 * 「启动哪个程序.json」（看板数据夹，两套系统共用）：六个点开哪个程序。没有就照默认写一份出来给人改；坏了回落默认。
 * 每次开窗现读，改了不用重开看板。
 */
function readLaunchConfig(): Record<string, LaunchTarget[]> {
  const path = join(bookmarkDataDirectory(), LAUNCH_CONFIG_FILE);
  try {
    if (!existsSync(path)) {
      if (openAgents) writeFileSync(path, formatLaunchConfig(), "utf8"); // 测试实例不往真数据夹写
      return parseLaunchConfig("{}");
    }
    return parseLaunchConfig(readFileSync(path, "utf8"));
  } catch (error) {
    log.出事(`读「${LAUNCH_CONFIG_FILE}」失败，用默认`, error, "cli");
    return parseLaunchConfig("{}");
  }
}

interface LaunchOpenResult {
  opened: string | null;
  freshWindow: boolean;
  /** true＝看板会等新窗口启动好替用户按 Ctrl+V，结果另发 bookmark:launch-pasted。 */
  pasting: boolean;
  problem: string | null;
}

/**
 * 打开这个组对应的桌面快捷方式（设定15第三版）。认不出的组、桌面没这个快捷方式、打开失败 → 不开，
 * 返回 problem 让界面提示「自己开窗」。开完替用户贴启动句：命令窗口贴进新窗口，桌面程序先 Ctrl+N 新开对话再贴（设定15第四版）。
 * 自测、验证脚本（隔离数据夹）只报会怎么做、不真开；设了 BOOKMARK_AGENT_SHORTCUT_DIR（放假快捷方式的夹）才真开。
 */
async function openAgentShortcut(group: string, line: string, label: string, waitPaste = false): Promise<LaunchOpenResult> {
  const targets = agentShortcutFor(group, readLaunchConfig());
  if (!targets) return { opened: null, freshWindow: false, pasting: false, problem: null };
  const fakeDir = process.env.BOOKMARK_AGENT_SHORTCUT_DIR;
  const dir = fakeDir || app.getPath("desktop");
  // 设置文件里按顺序找，这台电脑上有哪个开哪个（两套系统桌面不一样）。
  // 🚨 验证脚本用假桌面时只认桌面名字、不认完整路径：完整路径指的是真启动器，测一次就开一个真 AI 窗口（2026-09-24 踩过）。
  const resolved = targets
    .filter((t) => !(fakeDir && isAbsoluteTarget(t.open)))
    .map((t) => ({ spec: t, path: isAbsoluteTarget(t.open) ? t.open : join(dir, shortcutFileName(t.open)) }));
  const hit = resolved.find((r) => existsSync(r.path));
  if (!hit) {
    const names = targets.map((t) => (isAbsoluteTarget(t.open) ? basename(t.open) : t.open).replace(/\.lnk$/i, ""));
    return { opened: null, freshWindow: false, pasting: false, problem: `这台电脑上没找到「${names.join("」或「")}」（看板数据夹「${LAUNCH_CONFIG_FILE}」里改开哪个）` };
  }
  const spec = hit.spec;
  const path = hit.path;
  const name = basename(path).replace(/\.lnk$/i, "");
  if (!openAgents && !fakeDir) return { opened: name, freshWindow: spec.freshWindow, pasting: true, problem: null };
  try {
    const win32 = loadLaunchWin32();
    // 命令窗口：开窗前先记下已有的全部窗口，之后跑到最前面的只有不在这里面的才算新窗口，绝不往旧窗口里贴。
    // 桌面程序（Codex、Hermes）：按程序名认，旧窗口切到前面也算，贴之前先 Ctrl+N 新开对话。
    const before = win32 ? new Set(win32.windows()) : null;
    const errorMessage = await shell.openPath(path);
    if (errorMessage) throw new Error(errorMessage);
    if (win32 && before) {
      const pasting = pasteLaunchLine(win32, spec.app ?? null, before, line, label, spec.settleMs);
      if (waitPaste) await pasting;
    }
    return { opened: name, freshWindow: spec.freshWindow, pasting: Boolean(win32 && before), problem: null };
  } catch (error) {
    log.出事(`启动 Agent 开「${name}」失败（启动句已在剪贴板，用户可手动开）`, error, "cli");
    return { opened: null, freshWindow: false, pasting: false, problem: `「${name}」没打开` };
  }
}

/** 等新窗口启动好替用户按 Ctrl+V，结果告诉看板。🚨 只按 Ctrl+V 不按回车；出任何错都只是「没贴」，不连坐。 */
async function pasteLaunchLine(
  win32: LaunchWin32,
  appExe: string | null,
  before: Set<bigint>,
  line: string,
  label: string,
  settleMs?: number,
): Promise<void> {
  let result: { ok: boolean; reason: string | null };
  try {
    const deps = {
      foreground: () => win32.foreground(),
      processOf: (hwnd: bigint) => win32.processOf(hwnd),
      // 启动句在 Ctrl+N 时就放进剪贴板：写剪贴板那一刻截图、剪贴板工具会去读它、占住一小会儿，
      // 紧跟着 Ctrl+V 会贴空（2026-09-24 实测）。所以提前 1.5 秒写好，贴时剪贴板没被换掉就不再写。
      pressCtrlN: () => {
        clipboard.writeText(line);
        win32.pressCtrlN();
      },
      // 等的这几秒里用户可能复制了别的：不是启动句了才再放一次
      pressCtrlV: () => {
        if (clipboard.readText() !== line) clipboard.writeText(line);
        win32.pressCtrlV();
      },
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    const slow = settleMs ? { settleMs } : {};
    result = appExe
      ? await pasteIntoAppWindow(appExe, deps, { ...APP_PASTE_TIMING, ...slow })
      : await pasteIntoNewWindow(before, deps, { ...LAUNCH_PASTE_TIMING, ...slow });
  } catch (error) {
    log.出事("启动 Agent 贴字出错（用户自己贴）", error, "cli");
    result = { ok: false, reason: "贴字出错" };
  }
  log.记(`启动 Agent：${label} ${result.ok ? "已贴启动句（没按回车）" : `没贴：${result.reason}`}`, "cli");
  try {
    if (panel && !panel.isDestroyed()) panel.webContents.send("bookmark:launch-pasted", { label, ...result });
  } catch {
    /* 面板不在就算了 */
  }
}

const MODE_FILE = "mode.json";

/** 现在是哪一档：mode.json 缺了、坏了一律日常档。 */
function readBoardMode(): BoardMode {
  try {
    const path = join(bookmarkDataDirectory(), MODE_FILE);
    return existsSync(path) ? parseBoardMode(readFileSync(path, "utf8")) : "day";
  } catch {
    return "day";
  }
}

// ── 一条一份小文件（设定24，看板 Claude 01）：每条在数据夹里一份 md，条目删了跟着删 ──

const itemFileCache = new Map<string, string>();
let itemFileTimer: ReturnType<typeof setTimeout> | null = null;

function itemFilesDirectory(): string {
  return join(bookmarkDataDirectory(), ITEM_FILES_DIR);
}

/** 条目在看板上哪个组（屏幕上的叫法）。 */
function groupLabelOf(record: BookmarkRecord): string {
  if (record.assignee) return record.assignee;
  return record.kind === "handoff" ? "交接单专区" : "待定";
}

function syncItemFilesNow(): void {
  if (!store) return;
  if (itemFileTimer) {
    clearTimeout(itemFileTimer);
    itemFileTimer = null;
  }
  let titles: NoteBook = {};
  try {
    titles = readNoteBook();
  } catch {
    /* 没小标题就用原文开头 */
  }
  syncItemFiles(
    itemFilesDirectory(),
    store.list(),
    (r) => formatItemFile(r, { group: groupLabelOf(r), title: titles[r.id]?.title ?? null, images: (t) => imagesForAgent(t) }),
    itemFileCache,
  );
}

function scheduleItemFileSync(): void {
  if (itemFileTimer) clearTimeout(itemFileTimer);
  itemFileTimer = setTimeout(syncItemFilesNow, 300);
  itemFileTimer.unref?.();
}

/** 这条那份小文件的完整路径（先对齐一次，保证是最新的）。 */
function itemFileFor(id: string): string {
  syncItemFilesNow();
  const path = itemFilePath(itemFilesDirectory(), id);
  if (!existsSync(path)) throw new Error("这条已经不在了");
  return path;
}

/** 条目 id → 屏幕上的组名和号码（跟看板、show 同一个数法）。 */
function boardRows(): Map<string, { group: string; no: number }> {
  const out = new Map<string, { group: string; no: number }>();
  for (const g of indexBoard(requireStore().list(), requireRoster().list())) for (const row of g.rows) out.set(row.record.id, { group: g.name, no: row.no });
  return out;
}

function rowName(rows: Map<string, { group: string; no: number }>, record: BookmarkRecord): string {
  const row = rows.get(record.id);
  return row ? `第 ${String(row.no).padStart(2, "0")} 条（${row.group}）` : groupLabelOf(record);
}

/** 派活单派给哪个组：写了就认（大小写不管、只写开头也认），没写默认 Pi 组。 */
function resolveGroup(name: string | null | undefined): string {
  const agents = requireRoster().list();
  const want = String(name ?? "").trim().toLowerCase();
  if (want) {
    const exact = agents.find((a) => a.toLowerCase() === want);
    const prefix = agents.filter((a) => a.toLowerCase().startsWith(want));
    const hit = exact ?? (prefix.length === 1 ? prefix[0] : null);
    if (!hit) throw new Error(`看板上没有「${name}」这个组（现有：${agents.join("、")}）`);
    return hit;
  }
  const pi = agents.find((a) => /^pi(\s|$)/i.test(a));
  if (!pi) throw new Error("没说派给哪个组，默认的 Pi 组也不在看板上：用 --to 写组名");
  return pi;
}

/** 启动句开头（2026-10-15）：告诉新窗口规矩由 next 命令自己吐，开局不用先翻看板说明书——那 5 千字白读。 */
const LAUNCH_HEAD = "领看板的活（规矩这条命令会给，不用另读看板说明书）：";

/** 窗口名：组名去空格 + 递增号（Claude-3、PiAgent-7）。号存在 launch-seq.json，重启接着数，免得跟还开着的旧窗口撞名。 */
function nextWindowLabel(group: string): string {
  const path = join(bookmarkDataDirectory(), "launch-seq.json");
  let seq = 0;
  try {
    if (existsSync(path)) seq = Number(JSON.parse(readFileSync(path, "utf8")).seq) || 0;
  } catch {
    /* 坏档从 0 数，最多撞个旧名 */
  }
  seq += 1;
  try {
    writeJsonAtomic(path, { seq });
  } catch (error) {
    log.出事("launch-seq.json 写盘失败（窗口名可能重复，不影响使用）", error, "cli");
  }
  return `${group.replace(/\s+/g, "") || "Agent"}-${seq}`;
}

// ── AI 整理（设定21）：桌宠开起来 30 秒整理一次，之后每隔 intervalHours 一次；没新条目就不调模型 ──
// 第四版（2026-10-12）：整理完接着检查（看板没变的组不查）；全部重来存原样能撤销；记录、提示存 JSON，条目删了跟着删。

const ORGANIZER_FILE = "organizer.json";
const RECORDS_FILE = "AI整理记录.json";
const HINTS_FILE = "AI整理提示.json";
let organizerRunning = false;
let organizerLast: { at: string; text: string } | null = null;
let organizerTimer: NodeJS.Timeout | null = null;

function readOrganizerConfig(): OrganizerConfig {
  const file = join(bookmarkDataDirectory(), ORGANIZER_FILE);
  try {
    return parseOrganizerConfig(existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : {});
  } catch (error) {
    log.出事("AI 整理设置读不出来，按默认来（钥匙为空就不整理）", error, "organizer");
    return parseOrganizerConfig({});
  }
}

function writeOrganizerConfig(config: OrganizerConfig): void {
  writeJsonAtomic(join(bookmarkDataDirectory(), ORGANIZER_FILE), config);
}

function organizerStatus() {
  const c = readOrganizerConfig();
  const rules = readRulesFile(ORGANIZER_RULES_FILE, ORGANIZER_RULES);
  const checkRules = readRulesFile(CHECK_RULES_FILE, CHECK_RULES);
  return {
    models: c.models.map((m) => ({ id: m.id, provider: m.provider, baseUrl: m.baseUrl, model: m.model, hasKey: Boolean(m.apiKey), label: modelLabel(m) })),
    current: c.current, enabled: c.enabled, hasKey: Boolean(activeModel(c).apiKey), intervalHours: c.intervalHours,
    effort: c.effort, efforts: EFFORTS,
    rules, defaultRules: ORGANIZER_RULES, rulesIsDefault: rules === ORGANIZER_RULES,
    checkRules, defaultCheckRules: CHECK_RULES, checkRulesIsDefault: checkRules === CHECK_RULES,
    running: organizerRunning, last: organizerLast, canUndo: requireStore().canUndoReset(),
  };
}

// ── 整理记录 / 提示本：读的时候顺手把删掉的条目清出去 ──

function readJsonFile(name: string): unknown {
  const file = join(bookmarkDataDirectory(), name);
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : null;
  } catch (error) {
    log.出事(`${name} 读不出来，当空的`, error, "organizer");
    return null;
  }
}

function readRunRecords(): RunRecord[] {
  const raw = parseRunRecords(readJsonFile(RECORDS_FILE));
  const pruned = pruneRunRecords(raw, new Set(requireStore().list().map((r) => r.id)));
  if (JSON.stringify(pruned) !== JSON.stringify(raw)) writeJsonAtomic(join(bookmarkDataDirectory(), RECORDS_FILE), pruned);
  return pruned;
}

function appendRunRecord(run: RunRecord): void {
  if (!run.rows.length) return;
  try {
    writeJsonAtomic(join(bookmarkDataDirectory(), RECORDS_FILE), pruneRunRecords([run, ...readRunRecords()], new Set(requireStore().list().map((r) => r.id))));
  } catch (error) {
    log.出事("AI 整理记录写不进去", error, "organizer");
  }
}

/** 每条的小卡片（第五版）：项目、小标题、小结。读的时候顺手把删掉的条目清出去。 */
const NOTES_FILE = "AI条目小结.json";

function readNoteBook(): NoteBook {
  const raw = parseNoteBook(readJsonFile(NOTES_FILE));
  const live = liveNoteBook(raw, requireStore().list());
  if (Object.keys(live).length !== Object.keys(raw).length) writeNoteBook(live);
  return live;
}

function writeNoteBook(book: NoteBook): void {
  try {
    writeJsonAtomic(join(bookmarkDataDirectory(), NOTES_FILE), book);
  } catch (error) {
    log.出事("每条的小标题存不下来（下一轮会重读）", error, "organizer");
  }
}

/** 捆标题账本（2026-10-13）：每捆起名时的指纹，没变就不再花钱起名。 */
const NAMES_FILE = "AI捆标题.json";

function readNameBook(): NameBook {
  return parseNameBook(readJsonFile(NAMES_FILE));
}

function writeNameBook(book: NameBook): void {
  try {
    writeJsonAtomic(join(bookmarkDataDirectory(), NAMES_FILE), book);
  } catch (error) {
    log.出事("捆标题账本存不下来（下一轮会重起名）", error, "organizer");
  }
}

/** 闲了 5 分钟自动整理（2026-10-13 用户：停手 5 分钟没动，就自己重读、重分、重写标题；整理完没再变就不动）。
 *  每 30 秒看一眼整块看板的指纹：变了就记下时间；离最后一次变已经 5 分钟、又跟上次整理完的样子不一样，就整理一次。 */
const IDLE_MS = 5 * 60_000;
let idleTimer: NodeJS.Timeout | null = null;

function startIdleOrganizer(): void {
  let seenFp = boardFingerprint(requireStore().list());
  let changedAt = 0;
  let doneFp = seenFp; // 启动时的样子算整理过（启动 30 秒后定时那一轮会整理一次）
  idleTimer = setInterval(() => {
    try {
      const fp = boardFingerprint(requireStore().list());
      if (fp !== seenFp) {
        seenFp = fp;
        changedAt = Date.now();
        return;
      }
      if (organizerRunning || fp === doneFp || !changedAt || Date.now() - changedAt < IDLE_MS) return;
      if (!readOrganizerConfig().enabled) return;
      void runOrganizerOnce("闲了 5 分钟").finally(() => {
        doneFp = boardFingerprint(requireStore().list());
        seenFp = doneFp;
      });
    } catch (error) {
      log.出事("闲了 5 分钟自动整理没跑起来", error, "organizer");
    }
  }, 30_000);
  idleTimer.unref?.();
}

function hintBookPath(): string {
  return join(bookmarkDataDirectory(), HINTS_FILE);
}

function readHintBook(): HintBook {
  const raw = parseHintBook(readJsonFile(HINTS_FILE));
  const live = liveHintBook(raw, requireStore().list());
  if (live.hints.length !== raw.hints.length || live.dismissed.length !== raw.dismissed.length) writeHintBook(live);
  return live;
}

function writeHintBook(book: HintBook): void {
  writeJsonAtomic(hintBookPath(), book);
}

/** 规矩页的一份份规矩：示例窗口名、示例条目都是假的，只为让用户看到 AI 实际收到的那段话长什么样。 */
function boardRulesList(skillRoot: string) {
  const cli = bookmarkCliScriptPath();
  const item: CliRecord = {
    id: "示例条目", text: "（领到的那条任务原文）", url: null, assignee: "Claude", dedupeKey: null,
    detail: null, kind: "note", attachments: [], createdAt: "",
  };
  const base = { item, prompt: "（这里是那条任务的原文、图片、要求模板）", position: 1, total: 3, remaining: 2, busy: [] as string[] };
  const inCode = "写在程序里，要改跟 AI 说一声";
  const inSkill = (file: string) => `正文在看板程序夹 ${RULES_DIR} 里的 ${file}，要改跟 AI 说一声`;
  const rules: { key: string; group: string; title: string; note: string; text: string; editable: boolean }[] = [
    { key: "organizer", group: "AI 整理捆", title: "整理规矩", note: "整理模型照这个把新条目捆起来。能直接改，改完点保存", text: readRulesFile(ORGANIZER_RULES_FILE, ORGANIZER_RULES), editable: true },
    { key: "checker", group: "AI 整理捆", title: "检查规矩", note: "整理完照这个挑放错的、挂小橙点，一条都不挪。能直接改，改完点保存", text: readRulesFile(CHECK_RULES_FILE, CHECK_RULES), editable: true },
    { key: "item", group: "AI 整理捆", title: "读条目规矩", note: `整理第一步：一条一条读、每张图都看，写项目名、小标题、小结。${inSkill("读条目.md")}`, text: ITEM_RULES, editable: false },
    { key: "bundle-name", group: "AI 整理捆", title: "捆标题规矩", note: `捆里的条目变了，照这个重写捆标题。${inSkill("起捆名.md")}`, text: BUNDLE_NAME_RULES, editable: false },
    { key: "hard", group: "AI 整理捆", title: "程序卡死的规矩", note: `程序直接拿代码里的数拼出来的，跟真执行的一样。${inCode}`, text: hardRulesText(), editable: false },
    { key: "question", group: "AI 整理捆", title: "AI 每次收到的题目", note: "拿你看板现在的条目现做的：上面两份规矩之外，AI 就只收到这些", text: questionPreview(), editable: false },
    { key: "claim-day", group: "AI 领到活时看到的", title: "日常档", note: `一条和一捆一样：干完讲给你听，你说可以才删。${inCode}`,
      text: formatClaimMessage({ ...base, mode: "day" }, { cli, target: "b-示例捆", by: "Claude-3", coding: false }), editable: false },
    { key: "claim-sleep", group: "AI 领到活时看到的", title: "睡觉档", note: `干完写报告挂在条目下，你早上看了说可以再删。${inCode}`,
      text: formatClaimMessage({ ...base, mode: "sleep" }, { cli, group: "Claude", by: "Claude-3", coding: false }), editable: false },
    { key: "claim-coop", group: "AI 领到活时看到的", title: "多人派工（占住整捆）", note: inCode,
      text: formatClaimMessage({ ...base, cooperation: true, bundleId: "b-示例捆", coordinator: "主窗" }, { cli, target: "b-示例捆", by: "工兵-1", coding: false }), editable: false },
  ];
  for (const t of listTemplates(templatesDirectory())) {
    rules.push({ key: `template:${t.name}`, group: "AI 领到活时看到的", title: `要求模板 · ${t.name.replace(/\.md$/, "")}`, note: "「启动 Agent · 带编程」会把它拼在任务前面。在 设置 → 要求模板 → 打开文件夹 里改", text: t.text, editable: false });
  }
  for (const skill of listBoardSkills(skillRoot)) {
    try {
      rules.push({ key: `skill:${skill.name}`, group: "看板技能", title: skill.name, note: "AI 用看板干这类活时照着读。技能页里也能看", text: readBoardSkill(skillRoot, skill.name).text, editable: false });
    } catch {
      /* 读不了的技能跳过 */
    }
  }
  return rules;
}

/** 规矩页「AI 每次收到的题目」：拿看板现在第一组有条目的，现做整理题和检查题。 */
function questionPreview(): string {
  const store = requireStore();
  const groups = groupsForOrganizer(store.list(), requireRoster().list());
  const opts = { meta: store.bundleMeta(), openBundle: (id: string) => store.aiOpenBundle(id), notes: readNoteBook() };
  for (const g of groups) {
    const organize = buildGroupTask(g, { ...opts, now: Date.now(), previewAll: true });
    const check = buildCheckTask(g, opts);
    if (!organize && !check) continue;
    return [
      `下面拿「${g.label}」组现做。读条目一条一份、图片另附；整理题和检查题每组一份。`,
      "",
      "━━ 读条目题（拿这组第一条做例子）━━",
      buildItemTask(g.records[0], attachmentsRoot()).text,
      "",
      "━━ 整理题（散着的都当新条目，好让你看全格式；真整理时你动过的不送）━━",
      organize ? organize.text : "（这组现在没有能整理的条目）",
      "",
      "━━ 检查题 ━━",
      check ? check.text : "（这组没有捆，不用检查）",
    ].join("\n");
  }
  return "看板上现在没有能整理的条目，等有了再来看。";
}

/** 整理规矩 / 检查规矩（给模型的提示词）：用户改过就存成 md，没改过用代码里的默认。 */
const ORGANIZER_RULES_FILE = "AI整理规矩.md";
const CHECK_RULES_FILE = "AI检查规矩.md";

function readRulesFile(name: string, fallback: string): string {
  const file = join(bookmarkDataDirectory(), name);
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").trim() : "";
    return text || fallback;
  } catch (error) {
    log.出事(`${name} 读不出来，先用默认的`, error, "organizer");
    return fallback;
  }
}

function writeRulesFile(name: string, text: string, fallback: string): void {
  const file = join(bookmarkDataDirectory(), name);
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean || clean === fallback) {
    rmSync(file, { force: true });
    return;
  }
  if (clean.length > 20000) throw new Error("规矩太长了（最多两万字）");
  mkdirSync(bookmarkDataDirectory(), { recursive: true });
  writeFileSync(`${file}.tmp`, clean, "utf8");
  renameSync(`${file}.tmp`, file);
}

/** 走 Electron 自己的网络栈：跟着系统代理走，Clash 开着也能连上。 */
const organizerFetch: FetchFn = async (url, init) => {
  const res = await net.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/** 整理一次＝整理新条目＋检查一遍（2026-10-12 用户：是一个工作流）。lead 是全部重来那一行，放这次记录最前面。 */
async function runOrganizerOnce(reason: string, lead: RecordRow[] = []): Promise<void> {
  if (organizerRunning) return;
  const config = readOrganizerConfig();
  if (reason === "定时" && !config.enabled) return;
  if (!activeModel(config).apiKey) {
    organizerLast = { at: new Date().toISOString(), text: "AI 整理：还没填模型钥匙" };
    if (lead.length) {
      appendRunRecord({ at: organizerLast.at, model: "", rows: lead });
      notifyOrganized(organizerLast.text);
    }
    return;
  }
  // 全部重来的撤销机会只到下一次整理之前（补跑是接着上一轮没做完的，不算新的一次）。
  if (reason !== "全部重来" && reason !== FOLLOW_UP) requireStore().dropResetUndo();
  takeModelSwitches(); // 上一轮剩的不算这轮的
  organizerRunning = true;
  notifyOrganized("");
  const store = requireStore();
  const agents = requireRoster().list();
  const rows: RecordRow[] = [...lead];
  let model = modelLabel(activeModel(config));
  try {
    // 第一步读条目（第五版 2026-10-13）：一条一条读、每张图都看，写小标题和小结；读完一条存一次、板上马上露出小标题。
    let notes: NoteBook = readNoteBook();
    try {
      const read = await runItemNotes({ store, agents, config, fetchFn: organizerFetch, book: notes, attachmentsDir: attachmentsRoot(),
        onNote: (book) => { writeNoteBook(book); notifyInboxChanged(); } });
      notes = read.book;
      writeNoteBook(notes);
      const byId = new Map(store.list().map((r) => [r.id, r]));
      if (read.errors.length) {
        rows.push({ group: "全部", action: "没成", title: `${read.errors.length} 条没读成，下一轮再读`, why: read.errors.slice(0, 3).map((e) => e.error).join("；"),
          itemIds: read.errors.map((e) => e.id).filter((id) => byId.has(id)) });
      }
      if (read.read) log.记(`读条目：读了 ${read.read} 条`, "organizer");
    } catch (error) {
      log.出事(`${reason}读条目失败`, error, "organizer");
    }
    const summary = await runOrganizer({ store, agents, config, fetchFn: organizerFetch, attachmentsDir: attachmentsRoot(), rules: readRulesFile(ORGANIZER_RULES_FILE, ORGANIZER_RULES), notes });
    model = summary.model;
    rows.push(...organizeRows(summary, store.list()));
    // 捆名全交给 AI（2026-10-13）：没起过名的、条目进出过的、条目小标题变了的捆，重写大标题。
    try {
      const named = await runBundleNames({ store, agents, config, fetchFn: organizerFetch, notes, book: readNameBook() });
      writeNameBook(named.book);
      rows.push(...named.rows);
      for (const e of named.errors) rows.push({ group: e.split("：")[0], action: "没成", title: "有捆没起成名，下一轮再起", why: e, itemIds: [] });
      if (named.rows.length) notifyInboxChanged();
    } catch (error) {
      log.出事(`${reason}起捆名失败`, error, "organizer");
    }
    if (summary.changed) notifyInboxChanged();
    let text = shortSummary(summary);
    try {
      const check = await runChecker({ store, agents, config, fetchFn: organizerFetch, book: readHintBook(), rules: readRulesFile(CHECK_RULES_FILE, CHECK_RULES), notes });
      writeHintBook(check.book);
      rows.push(...check.rows);
      for (const e of check.errors) rows.push({ group: e.split("：")[0], action: "没成", title: "这组没检查成，下一轮再查", why: e, itemIds: [] });
      if (check.newHints) text += `；检查出 ${check.newHints} 条可能放错（看板上的小橙点）`;
      else if (check.checkedGroups) text += "；检查过了，没有放错的";
    } catch (error) {
      log.出事(`${reason}检查失败`, error, "organizer");
      text += `；检查没成：${error instanceof Error ? error.message : error}`;
    }
    organizerLast = { at: summary.at, text };
    log.记(`${reason}整理：${text}`, "organizer");
  } catch (error) {
    organizerLast = { at: new Date().toISOString(), text: `AI 整理没成：${error instanceof Error ? error.message : error}` };
    log.出事(`${reason}整理失败`, error, "organizer");
  } finally {
    organizerRunning = false;
    for (const note of takeModelSwitches()) rows.push({ group: "全部", action: "换模型", title: note, why: "选中的模型重拨几次都不通，自动换了设置里的下一个模型", itemIds: [] });
    if (scheduleFollowUp(rows.some((r) => r.action === "没成")) && organizerLast) organizerLast.text += `；没成的 ${FOLLOW_UP_MIN} 分钟后自动再试`;
    appendRunRecord({ at: new Date().toISOString(), model, rows });
    notifyOrganized(organizerLast?.text ?? "");
  }
}

/** 补跑（2026-10-13：对面一时忙，整组没整理成，原来要等 2 小时下一轮）：这轮有没成的，过几分钟再整理一次；连着补 3 次还不成就等定时那一轮。 */
const FOLLOW_UP = "补跑";
const FOLLOW_UP_MIN = 5;
const MAX_FOLLOW_UPS = 3;
let followUpTimer: NodeJS.Timeout | null = null;
let followUps = 0;

/** 这轮有没成的就排一次补跑，返回排上了没有；全成了把次数清零。 */
function scheduleFollowUp(failed: boolean): boolean {
  if (!failed) {
    followUps = 0;
    return false;
  }
  if (followUpTimer) return true;
  if (followUps >= MAX_FOLLOW_UPS) {
    followUps = 0;
    return false;
  }
  followUps += 1;
  followUpTimer = setTimeout(() => {
    followUpTimer = null;
    void runOrganizerOnce(FOLLOW_UP);
  }, FOLLOW_UP_MIN * 60_000);
  followUpTimer.unref?.();
  return true;
}

function startOrganizerTimer(firstMs = 30_000): void {
  const schedule = (ms: number) => {
    organizerTimer = setTimeout(() => {
      void runOrganizerOnce("定时").finally(() => schedule(readOrganizerConfig().intervalHours * 3600_000));
    }, ms);
    organizerTimer.unref?.();
  };
  schedule(firstMs);
}

/** 整理开始（text 空）、整理完都发一声：设置窗口刷新记录、看板刷新小橙点。 */
function notifyOrganized(text: string): void {
  if (text) scheduleItemFileSync(); // 小标题可能换了，小文件第一行跟着换
  try {
    if (panel && !panel.isDestroyed()) panel.webContents.send("bookmark:organized", text);
  } catch {
    /* 面板不在就算了 */
  }
}

function requireRoster(): AgentRoster {
  if (!roster) throw new Error("书签台还没初始化（initBookmarkPanel 没被调）");
  return roster;
}

function requireStore(): BookmarkStore {
  if (!store) throw new Error("书签台还没初始化（initBookmarkPanel 没被调）");
  return store;
}

/** 手机消息入库后叫面板重拉列表。通知失败无所谓（Ctrl+R 手动刷新兑底）。 */
function notifyInboxChanged(): void {
  try {
    if (panel && !panel.isDestroyed()) panel.webContents.send("bookmark:inbox-changed");
  } catch {
    /* 面板不在就跳过，别让刷新通知出幺蛾子 */
  }
}

function normalizeInput(input: unknown): { text: string; url: string | null; assignee: string | null; dedupeKey: string | null; detail: string | null; kind: "note" | "handoff"; forSystem: string | null } {
  const raw = (input ?? {}) as { text?: unknown; url?: unknown; assignee?: unknown; dedupeKey?: unknown; detail?: unknown; kind?: unknown; forSystem?: unknown };
  const text = String(raw.text ?? "").trim();
  if (!text) throw new Error("书签内容不能为空");
  return {
    text,
    url: raw.url ? String(raw.url) : null,
    assignee: raw.assignee ? String(raw.assignee) : null,
    dedupeKey: raw.dedupeKey ? String(raw.dedupeKey) : null,
    detail: raw.detail ? String(raw.detail) : null,
    kind: raw.kind === "handoff" ? "handoff" : "note",
    forSystem: normalizeForSystem(raw.forSystem),
  };
}

// ── CLI 接入的读写口（cli-server 收到请求后走这里，与 UI/IPC 同一个 store 同一条管道） ──

/** CLI 写入：POST /add → 与 IPC add 同一条 normalizeInput 管道，入库后由 cli-server 统一回调刷新。 */
export function bookmarkCliAdd(input: unknown): BookmarkRecord {
  return requireStore().add(normalizeInput(input));
}

/** CLI 读取：GET /list → 新→旧快照（过滤逻辑在 cli-server 纯函数里做）。 */
export function bookmarkCliList(): BookmarkRecord[] {
  return requireStore().list();
}

/** CLI 删除：POST /remove → 与 IPC remove 同一管道；没找到返回 false。 */
export function bookmarkCliRemove(id: string): boolean {
  return requireStore().remove(String(id ?? ""));
}

// ── 外观设置（透明度）：appearance.json 读写（纯函数在 appearance.ts） ──

function readBoardOpacity(): number {
  try {
    if (!existsSync(bookmarkAppearancePath())) return DEFAULT_BOARD_OPACITY;
    return parseAppearance(readFileSync(bookmarkAppearancePath(), "utf8"));
  } catch (error) {
    log.出事("appearance.json 读取失败（回落默认透明度）", error, "appearance");
    return DEFAULT_BOARD_OPACITY;
  }
}

function writeBoardOpacity(opacity: number): number {
  const clamped = clampOpacity(opacity);
  try {
    mkdirSync(bookmarkDataDirectory(), { recursive: true });
    writeJsonAtomic(bookmarkAppearancePath(), { opacity: clamped });
  } catch (error) {
    log.出事("appearance.json 写盘失败（本次不记忆，看板照用）", error, "appearance");
  }
  return clamped;
}

// ── 手机项目页（2026-09-25）：跟整板一起发项目夹和 md 内容，手机只能看。读坏了就不带，整板照发 ──

function readProjectsForPhone(): BoardProjectNode[] | undefined {
  try {
    const root = projectsRoot();
    if (!existsSync(root)) return [];
    return collectProjects(
      (rel) => listProjects(root, rel).ordered,
      (rel) => readFileSync(resolveProjectPath(root, rel), "utf8"),
    );
  } catch (error) {
    log.出事("抄项目页给手机失败（这回不带项目页）", error, "board");
    return undefined;
  }
}

// ── 字号（2026-09-24 用户拍板）：Ctrl+等号/减号/0、Ctrl+滚轮，只管看板窗口；zoom.json 记住，重开照旧 ──
// 🚨 在看板窗口的 before-input-event 里拦，不准改成 globalShortcut——全局会抢掉其他软件的 Ctrl 加减。
// 不靠 Electron 自带菜单的放大键：它认的是「Ctrl+加号」，Windows 上要按 Shift，用户按 Ctrl+等号没反应（当天实测）。

function boardZoomPath(): string {
  return join(bookmarkDataDirectory(), "zoom.json");
}

function readBoardZoom(): number {
  try {
    if (!existsSync(boardZoomPath())) return DEFAULT_BOARD_ZOOM;
    return parseZoom(readFileSync(boardZoomPath(), "utf8"));
  } catch (error) {
    log.出事("zoom.json 读取失败（回落 100%）", error, "zoom");
    return DEFAULT_BOARD_ZOOM;
  }
}

function writeBoardZoom(zoom: number): void {
  try {
    mkdirSync(bookmarkDataDirectory(), { recursive: true });
    writeJsonAtomic(boardZoomPath(), { zoom });
  } catch (error) {
    log.出事("zoom.json 写盘失败（本次不记忆，看板照用）", error, "zoom");
  }
}

function wireBoardZoom(win: BrowserWindow): void {
  let zoom = readBoardZoom();
  const apply = (): void => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(zoom);
  };
  const change = (next: number): void => {
    zoom = clampZoom(next);
    apply();
    writeBoardZoom(zoom);
    const tip = `字号 ${Math.round(zoom * 100)}%`;
    // 弹一行小字让用户知道调到多大了；提示函数不在也不影响调字号。
    void win.webContents.executeJavaScript(`typeof bmToast === "function" && bmToast(${JSON.stringify(tip)}, 1200)`)
      .catch(() => undefined);
    log.记(`看板${tip}`, "zoom");
  };
  // 页面每次加载（含自测刷新）Chromium 可能把缩放打回默认，加载完重新套上。
  win.webContents.on("did-finish-load", apply);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const action = zoomActionForKey(input);
    if (!action) return;
    event.preventDefault();
    change(action === "reset" ? DEFAULT_BOARD_ZOOM : stepZoom(zoom, action));
  });
  // Ctrl+滚轮：Electron 不自己缩放，只发这个事件，照走一档。
  win.webContents.on("zoom-changed", (_event, direction) => change(stepZoom(zoom, direction)));
}
