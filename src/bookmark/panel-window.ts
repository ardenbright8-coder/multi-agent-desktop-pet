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
// 状态标志位只有 F1 翻转（纯函数 pinToggleSteps 在 dock.ts，单测覆盖）。

import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, shell } from "electron";
import { createLogger } from "../shared/log";
import { writeJsonAtomic } from "../shared/atomic-file";
import { bookmarkAppearancePath, bookmarkDataDirectory } from "../shared/paths";
import { computeDockedBounds, parseSavedWindowSize, HWND_BOTTOM, SWP_ZORDER_FLAGS, pinToggleSteps } from "./dock";
import { AgentRoster } from "./agents";
import { BookmarkStore, type BookmarkRecord } from "./store";
import { ensureBookmarkInboxStarted, stopBookmarkInbox } from "./inbox";
import { startBookmarkCliServer } from "./cli-server";
import { clampOpacity, DEFAULT_BOARD_OPACITY, parseAppearance } from "./appearance";
import { createProjectFolder, createProjectMarkdown, ensureProjectsRoot, listProjects, projectsRoot, reorderProjects, resolveProjectPath } from "./projects";
import { composeForAgent, listTemplates } from "./templates";
import { registerBookmarkImageIpc } from "./image-ipc";

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
let store: BookmarkStore | null = null;
let roster: AgentRoster | null = null;
let hotkeyRegistered = false;
/** 真机 Ctrl+R 走编译+整程序重开；自测保持面板刷新。 */
let liveRestart = false;
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
    log.记(pinnedTopmost ? "F1：看板置顶（再按一次沉回最底层）" : "F1：看板沉回最底层", "window");
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
  liveRestart = Boolean(options?.liveRestart);
  registerIpc();
  if (options?.hotkey) registerHotkey();
  if (options?.inbox) {
    // 收信模块：坏了只记日志不连坐（隔离铁律）；连不上邮局会自己指数退避重连。
    try {
      ensureBookmarkInboxStarted({ store: requireStore(), onInboxChanged: notifyInboxChanged });
    } catch (error) {
      log.出事("收信模块启动失败（看板仍可用，只是收不到手机消息）", error, "inbox");
    }
  }
  if (options?.resident) {
    try {
      const win = ensurePanel();
      if (rendererReady) showDocked(win);
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
        done: (id, by, userOk) => {
          const record = requireStore().done(id, by, userOk);
          log.记(`${by} 干完删掉「${record.text.slice(0, 30)}」（用户原话：${userOk.slice(0, 60)}）`, "cli");
          return record;
        },
        release: (id) => requireStore().release(id),
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
    if (!win.isDestroyed() && win.isVisible()) sinkToBottom(win);
    // 等 Windows 自己那一下「变灰」处理完再补发，不然会被它盖回去。
    setTimeout(() => keepAcrylicLit(win), 0);
  });
  win.on("show", () => setTimeout(() => keepAcrylicLit(win), 0));
  win.on("closed", () => {
    panel = null;
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

/** 编译当前源码再整程序重开。失败不重开，把原因交回面板。 */
function rebuildAndRelaunch(): { ok: boolean; mode: "relaunch"; error?: string } {
  const appRoot = app.getAppPath();
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  log.记(`Ctrl+R：开始编译源码（${appRoot}）`, "reload");
  // Windows 上直接 spawn npm.cmd 会 EINVAL，看板就报「换新失败」。走 cmd.exe。
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"], {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 180_000,
        windowsHide: true,
      })
    : spawnSync(npmCmd, ["run", "build"], {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 180_000,
        windowsHide: true,
      });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}
${result.stdout || ""}`.trim();
    log.出事(`Ctrl+R 编译失败（status=${result.status}）`, detail || result.error, "reload");
    return { ok: false, mode: "relaunch", error: detail.slice(0, 500) || "编译失败" };
  }
  const args = process.argv.slice(1).filter((item) => item !== RELAUNCH_FLAG).concat(RELAUNCH_FLAG);
  log.记("Ctrl+R：编译完成，整程序重开", "reload");
  app.relaunch({ args });
  app.quit();
  return { ok: true, mode: "relaunch" };
}

function registerIpc(): void {
  registerBookmarkImageIpc((sender) => Boolean(panel && !panel.isDestroyed() && sender === panel.webContents));
  ipcMain.handle("bookmark:list", () => requireStore().list());
  ipcMain.handle("bookmark:add", (_event, input: unknown) => requireStore().add(normalizeInput(input)));
  ipcMain.handle("bookmark:insert-beside", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { anchorId?: unknown; place?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    const anchorId = raw.anchorId ? String(raw.anchorId) : null;
    return requireStore().insertBeside(anchorId, place, normalizeInput(payload));
  });
  ipcMain.handle("bookmark:move", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; anchorId?: unknown; place?: unknown };
    const place = raw.place === "below" ? "below" : "above";
    return requireStore().move(String(raw.id ?? ""), String(raw.anchorId ?? ""), place);
  });
  ipcMain.handle("bookmark:remove", (_event, id: unknown) => requireStore().remove(String(id)));
  ipcMain.handle(
    "bookmark:set-assignee",
    (_event, payload: unknown) => {
      const { id, assignee } = (payload ?? {}) as { id?: unknown; assignee?: unknown };
      return requireStore().setAssignee(String(id), assignee == null || assignee === "" ? null : String(assignee));
    },
  );
  // 输入行自动存档（2026-09-11 改版三）：草稿入库后边写边改同一条（renderer 防抖 400ms + 失焦必落盘，写了就是写了）。
  ipcMain.handle(
    "bookmark:update-text",
    (_event, payload: unknown) => {
      const { id, text, url } = (payload ?? {}) as { id?: unknown; text?: unknown; url?: unknown };
      return requireStore().updateText(String(id), String(text ?? ""), url ? String(url) : null);
    },
  );
  // 旧 bookmark:hide（收起面板）已随 F3 一起撤（改版三：看板永远常驻显示）。
  // 局部 Ctrl+R（面板内监听，🚨 不准改成 globalShortcut——全局会拦掉其他软件的 Ctrl+R）。
  // 真机：编译源码 + 整程序重开（跟脑图设定11同一套，等几秒正常）。自测：只刷新面板。
  ipcMain.handle("bookmark:reload", () => {
    if (!liveRestart) {
      if (panel && !panel.isDestroyed()) panel.webContents.reload();
      return { ok: true, mode: "reload" as const };
    }
    return rebuildAndRelaunch();
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
  // 捆一捆 / 拆开 / 放回去（设定15）
  ipcMain.handle("bookmark:bundle", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { id?: unknown; targetId?: unknown };
    return requireStore().bundleWith(String(raw.id ?? ""), String(raw.targetId ?? ""));
  });
  ipcMain.handle("bookmark:unbundle", (_event, bundleId: unknown) => requireStore().unbundle(String(bundleId ?? "")));
  ipcMain.handle("bookmark:release", (_event, id: unknown) => requireStore().release(String(id ?? "")));
  // 启动 Agent（设定15）：看板给这个窗口起名，拼一句「领看板的活」进剪贴板。自动开窗填字另有任务书，
  // 做好之前用户自己开窗 Ctrl+V。🚨 绝不替他按回车。
  ipcMain.handle("bookmark:launch-line", (_event, payload: unknown) => {
    const raw = (payload ?? {}) as { target?: unknown; group?: unknown; coding?: unknown };
    const target = String(raw.target ?? "").trim();
    const group = String(raw.group ?? "").trim();
    if (!target || !group) throw new Error("缺条目或组名");
    const label = nextWindowLabel(group);
    const line = `领看板的活：node "${bookmarkCliScriptPath()}" next ${target} --by ${label}${raw.coding ? " --coding" : ""}`;
    clipboard.writeText(line);
    log.记(`启动 Agent：${label} ← ${target}${raw.coding ? "（带编程）" : ""}`, "cli");
    return { line, label };
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

function normalizeInput(input: unknown): { text: string; url: string | null; assignee: string | null; dedupeKey: string | null; detail: string | null; kind: "note" | "handoff" } {
  const raw = (input ?? {}) as { text?: unknown; url?: unknown; assignee?: unknown; dedupeKey?: unknown; detail?: unknown; kind?: unknown };
  const text = String(raw.text ?? "").trim();
  if (!text) throw new Error("书签内容不能为空");
  return {
    text,
    url: raw.url ? String(raw.url) : null,
    assignee: raw.assignee ? String(raw.assignee) : null,
    dedupeKey: raw.dedupeKey ? String(raw.dedupeKey) : null,
    detail: raw.detail ? String(raw.detail) : null,
    kind: raw.kind === "handoff" ? "handoff" : "note",
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
