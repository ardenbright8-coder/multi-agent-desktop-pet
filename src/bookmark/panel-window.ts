// 书签台面板：独立 BrowserWindow + 全局热键 + 本块专属 IPC。
// 🚨 隔离铁律：本块断网/崩溃不许连坐桌宠本体。对外只露出下面三个函数，
// app.ts 装配时调 initBookmarkPanel()；托盘入口经 app.ts 注入 PetTrayActions（pet 块不 import 本块）。
//
// 改版二（2026-09-10 用户拍板）：看板**常驻贴屏**——启动即显示、贴主屏右缘占 1/3 宽、
// **总在其他窗口之下**（压在桌面上、被别的窗口盖，绝不挡人）；失焦即沉底，聚焦期间不压
// （用户正打字时不许被盖）。热键 Alt+S 撤，改 F3 = 显示/收起切换。

import { join } from "node:path";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";
import { createLogger } from "../shared/log";
import { writeJsonAtomic } from "../shared/atomic-file";
import { bookmarkAppearancePath, bookmarkDataDirectory } from "../shared/paths";
import { computeDockedBounds, parseSavedWindowSize, HWND_BOTTOM, SWP_SINK_FLAGS } from "./dock";
import { AgentRoster } from "./agents";
import { BookmarkStore, type BookmarkRecord } from "./store";
import { ensureBookmarkInboxStarted, stopBookmarkInbox } from "./inbox";
import { startBookmarkCliServer } from "./cli-server";
import { clampOpacity, DEFAULT_BOARD_OPACITY, parseAppearance } from "./appearance";

const log = createLogger("bookmark");

export const BOOKMARK_HOTKEY = "F3";

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

/** 版本戳：启动时算一次（git 短 hash + 当前时间），整个运行期不变——reload 不变，重启才变，
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
let pendingShow = false;
let rendererReady = false;
let sinkTimer: NodeJS.Timeout | null = null;
let sinkWarned = false;

// koffi（Win32 SetWindowPos）惰性加载：加载失败只警告一次，看板照常工作（只是不沉底），
// 隔离铁律——这里出任何幺蛾子不许连坐桌宠本体。
// HWND 传参用 uintptr_t + BigInt（实测 void* + Buffer 会静默失败返回 false）。
type SetWindowPosFn = (hwnd: bigint, after: bigint, x: number, y: number, cx: number, cy: number, flags: number) => boolean;
let setWindowPos: SetWindowPosFn | null = null;

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
    const ok = fn(hwndBig, BigInt(HWND_BOTTOM), 0, 0, 0, 0, SWP_SINK_FLAGS);
    if (!ok) log.出事("SetWindowPos 返回 false（沉底没生效）", undefined, "window");
  } catch (error) {
    log.出事("沉底失败（不影响使用）", error, "window");
  }
}

export interface BookmarkPanelOptions {
  /** 注册全局热键。自测模式传 false，别跟真机抢热键。 */
  hotkey?: boolean;
  /** 常驻模式：装配完立刻建窗并显示（贴右缘、沉底）。自测模式传 false，走旧惰性路径，别干扰测试。 */
  resident?: boolean;
  /** 收信模块（连 ntfy 邮局收手机消息）。自测模式传 false，别连真邮局。 */
  inbox?: boolean;
}

/** 装配口：注册 IPC（+ 可选热键、常驻显示）。书签台的任何失败在这里被吞掉记日志，不许往外炸。 */
export function initBookmarkPanel(options?: BookmarkPanelOptions): void {
  if (store) return;
  store = new BookmarkStore();
  roster = new AgentRoster();
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
      },
      onChanged: notifyInboxChanged,
    });
  } catch (error) {
    log.出事("CLI 接入服务启动失败（看板仍可用，只是命令行连不上）", error, "cli");
  }
  log.记("书签台就绪（Agent 看板·常驻贴屏）", "init");
}

/** 显示/收起面板（热键和托盘都走这里）。 */
export function toggleBookmarkPanel(): void {
  try {
    if (!panel) {
      panel = createPanel();
      pendingShow = true;
      if (rendererReady) showDocked(panel);
      startSinkTimer();
      return;
    }
    if (panel.isVisible()) {
      panel.hide();
      return;
    }
    showDocked(panel);
  } catch (error) {
    log.出事("书签台显示/收起失败", error, "toggle");
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
    const ok = globalShortcut.register(BOOKMARK_HOTKEY, toggleBookmarkPanel);
    hotkeyRegistered = ok;
    if (ok) log.记(`全局热键已注册 ${BOOKMARK_HOTKEY}（显示/收起）`, "init");
    else log.出事(`全局热键 ${BOOKMARK_HOTKEY} 注册失败（被别的程序占了？书签台仍常驻显示，可从托盘开关）`, undefined, "init");
  } catch (error) {
    log.出事("热键注册异常（书签台仍常驻显示，可从托盘开关）", error, "init");
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
          /* 真没救了，留在隐藏态，托盘/F3 还能开 */
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
  });
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
    // 🚨 常驻沉底窗口：永远不置顶（置顶层级是桌宠窗口的，抢层级会打架）。
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

function registerIpc(): void {
  ipcMain.handle("bookmark:list", () => requireStore().list());
  ipcMain.handle("bookmark:add", (_event, input: unknown) => requireStore().add(normalizeInput(input)));
  ipcMain.handle("bookmark:remove", (_event, id: unknown) => requireStore().remove(String(id)));
  ipcMain.handle(
    "bookmark:set-assignee",
    (_event, payload: unknown) => {
      const { id, assignee } = (payload ?? {}) as { id?: unknown; assignee?: unknown };
      return requireStore().setAssignee(String(id), assignee == null || assignee === "" ? null : String(assignee));
    },
  );
  ipcMain.handle("bookmark:hide", () => {
    panel?.hide();
  });
  // 局部刷新（面板内 Ctrl+R 触发，renderer 键盘监听发上来；🚨 不准改成 globalShortcut——全局会拦掉其他软件的 Ctrl+R）。
  ipcMain.handle("bookmark:reload", () => {
    if (panel && !panel.isDestroyed()) panel.webContents.reload();
  });

  // ── Agent 看板分组（2026-09-10 改版）：分组清单独立存 agents.json ──
  ipcMain.handle("bookmark:agents", () => requireRoster().list());
  // 外观设置（透明度）：读用在面板首渲染前，写由滑条防抖调（存 appearance.json）。
  ipcMain.handle("bookmark:appearance:get", () => readBoardOpacity());
  ipcMain.handle("bookmark:appearance:set", (_event, opacity: unknown) => writeBoardOpacity(Number(opacity)));
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
