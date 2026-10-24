// Agent命令快捷窗口（2026-10-12 用户拍板）：在 Windows 终端里按 Ctrl+Q，终端右下角、Claude 输入框上面弹出一列玻璃按钮，
// 点一个，字打进按 Ctrl+Q 的那个终端窗口，不替用户回车；点完自动收。
//
// 🚨 隔离铁律：这块只借桌宠程序当入口，跟桌宠、看板零共享状态，只认 shared。坏了只记日志，不许连坐别人。
// 对外只露出 initQuickCmd / closeQuickCmd，app.ts 装配时调。
//
// 怎么做到的：
// - Ctrl+Q 只在终端在最前面时才归它：每 200 毫秒看一眼最前面是谁，是终端才注册，不是就注销，别的软件的 Ctrl+Q 照旧
// - 字怎么进去：按钮名单读的是终端自己的设置文件（终端那个 Ctrl+Q 备胎弹框用的同一份），每个按钮在终端里绑了 F13～F24，
//   点按钮＝替用户按一下那个键，终端自己把字打进输入框。跟备胎一个办法，不动剪贴板
// - 窗口从不抢焦点（focusable:false），所以点按钮时终端一直在最前面，键就按给它
// - 弹出前先截一张屏：在终端那块里找输入框上面那条横线定位置；再把窗口身后那一小块剪下来给界面当底，模糊一下就是毛玻璃
//   （2026-10-12 实机：Windows 自带的 acrylic 在不抢焦点的窗口上是一块暗灰、圆角外还露黑，用户否了）
// - 开着的时候：每秒重量一次那条线，输入框打字变高了窗口跟着往上挪；鼠标在窗口外面按下就收（用户要的：点终端别处也收）
// - 按钮能拖：拖起来别的按钮实时让位，松手插到那个位置（2026-10-17 从「交换」改的），顺序记在 quickcmd-order.json
// - 「打开文件」按钮（终端里打 `! explorer "路径"` 的）窗口自己开文件，不往终端打字（2026-10-17：输入框有字时会接在后面一起发出去）。
//   是网页就在原位置弹说明面板（sheet-window.ts），不开浏览器；别的文件交给系统默认程序

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, shell, type NativeImage } from "electron";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { appDataRoot } from "../shared/paths";
import { closeSheet, openSheet } from "./sheet-window";
import {
  applyOrder,
  computePanelBounds,
  computeSheetBounds,
  findInputTopLine,
  isTerminalProcess,
  moveButton,
  parseOrder,
  parseTerminalButtons,
  resolveMovedPath,
  type QuickButton,
  type Rect,
} from "./layout";
import { loadQuickWin32, type QuickWin32 } from "./win32";

const log = createLogger("quickcmd");

const HOTKEY = "Ctrl+Q";
const POLL_MS = 200;
/** 开着时看鼠标的频率：一次点击大概按下 100 毫秒，50 毫秒看一次漏不掉。 */
const MOUSE_POLL_MS = 50;
/** 开着时重量那条线的频率（要截一次屏，别太勤）。 */
const FOLLOW_MS = 1_000;

function orderPath(): string {
  return join(appDataRoot(), "quickcmd-order.json");
}

function readOrder(): string[] {
  try {
    return existsSync(orderPath()) ? parseOrder(readFileSync(orderPath(), "utf8")) : [];
  } catch {
    return [];
  }
}

function terminalSettingsPath(): string {
  const local = process.env.LOCALAPPDATA || "";
  return join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json");
}

let win32: QuickWin32 | null = null;
let panel: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let hotkeyOn = false;
let shuttingDown = false;
let opening = false;
/** 按 Ctrl+Q 时最前面的那个终端窗口：按钮只往它里面打字。 */
let target = 0n;
/** 弹出那一刻终端窗口的位置（物理像素）。终端挪了、改大小了就收起来，下次按 Ctrl+Q 重新量。 */
let targetRectKey = "";
let buttons: QuickButton[] = [];
let pageLoaded = false;
let pendingReveal: { labels: string[]; background: string } | null = null;
let mouseTimer: NodeJS.Timeout | null = null;
let followTimer: NodeJS.Timeout | null = null;
let following = false;
/** 上一次看鼠标时是不是按着；按下那一刻在窗口里（比如正在拖按钮），拖出窗口也不收。 */
let mouseWasDown = false;
let pressStartedInside = false;
/** 按 Ctrl+Q 那一刻截的屏和量到的位置：点了网页按钮，说明面板拿它当玻璃底、定位置。收窗口时扔掉。 */
let lastView: { shot: NativeImage | null; scale: number; origin: { x: number; y: number }; terminal: Rect; lineY: number | null } | null = null;
/** 最前面窗口 → 是不是终端，问过的记住（每 200 毫秒问一次程序路径太浪费）。 */
const terminalCache = new Map<bigint, boolean>();

/** 装配口。任何失败在这里吞掉记日志，不往外炸。 */
export function initQuickCmd(): void {
  try {
    win32 = loadQuickWin32();
    if (!win32) return;
    ipcMain.on("quickcmd:press", (_event, index: unknown) => {
      if (typeof index === "number") press(index);
    });
    ipcMain.on("quickcmd:move", (_event, from: unknown, to: unknown) => {
      if (typeof from === "number" && typeof to === "number") move(from, to);
    });
    pollTimer = setInterval(tick, POLL_MS);
    pollTimer.unref();
    log.记("Agent命令快捷窗口就绪（终端里按 Ctrl+Q）", "init");
  } catch (error) {
    log.出事("Agent命令快捷窗口初始化失败（不影响桌宠、看板）", error, "init");
  }
}

/** 退出清理：停定时器、退热键、关窗口。 */
export function closeQuickCmd(): void {
  shuttingDown = true;
  try {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    stopWatching();
    setHotkey(false);
    panel?.destroy();
    panel = null;
    closeSheet();
  } catch (error) {
    log.出事("Agent命令快捷窗口退出清理失败", error, "close");
  }
}

function isTerminal(hwnd: bigint): boolean {
  if (!win32 || hwnd === 0n) return false;
  let known = terminalCache.get(hwnd);
  if (known === undefined) {
    known = isTerminalProcess(win32.processOf(hwnd));
    if (terminalCache.size > 200) terminalCache.clear();
    terminalCache.set(hwnd, known);
  }
  return known;
}

function setHotkey(on: boolean): void {
  if (on === hotkeyOn) return;
  try {
    if (on) {
      hotkeyOn = globalShortcut.register(HOTKEY, () => void toggle());
      if (!hotkeyOn) log.出事(`${HOTKEY} 注册失败（被别的程序占了？终端自己的 Ctrl+Q 弹框照样能用）`, undefined, "hotkey");
    } else {
      globalShortcut.unregister(HOTKEY);
      hotkeyOn = false;
    }
  } catch (error) {
    hotkeyOn = false;
    log.出事("Ctrl+Q 注册/注销异常", error, "hotkey");
  }
}

function rectKey(rect: Rect | null): string {
  return rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "";
}

/** 每 200 毫秒：最前面是终端 → Ctrl+Q 归我们；窗口开着时终端不在最前面了、挪了、改大小了 → 收。 */
function tick(): void {
  if (!win32 || shuttingDown) return;
  try {
    const fg = win32.foreground();
    setHotkey(isTerminal(fg));
    if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
    if (fg !== target || !win32.isWindow(target) || rectKey(win32.rectOf(target)) !== targetRectKey) hide();
  } catch (error) {
    log.出事("定时检查失败（不影响使用）", error, "tick");
  }
}

async function toggle(): Promise<void> {
  if (!win32 || opening) return;
  try {
    if (panel && !panel.isDestroyed() && panel.isVisible()) {
      hide();
      return;
    }
    const fg = win32.foreground();
    if (!isTerminal(fg)) return;
    let text = "";
    try {
      text = readFileSync(terminalSettingsPath(), "utf8");
    } catch (error) {
      log.出事("读不到终端设置文件，不弹", error, "toggle");
      return;
    }
    buttons = applyOrder(parseTerminalButtons(text), readOrder());
    if (buttons.length === 0) {
      log.出事("终端设置里没有绑了 F13～F24 的按钮（重跑一遍 加命令按钮.py），不弹", undefined, "toggle");
      return;
    }
    const physical = win32.rectOf(fg);
    if (!physical) return;
    opening = true;
    target = fg;
    targetRectKey = rectKey(physical);
    const display = screen.getDisplayMatching(screen.screenToDipRect(null, physical));
    const shot = await captureDisplay(display);
    const scale = display.scaleFactor;
    const origin = { x: display.bounds.x * scale, y: display.bounds.y * scale };
    const lineY = shot ? measureLine(shot, physical, display) : null;
    if (shot && lineY === null) log.记("截图里没找到输入框那条线，先放在终端靠下的位置", "toggle");
    const terminal = screen.screenToDipRect(null, physical);
    const bounds = computePanelBounds(terminal, buttons.length, lineY);
    lastView = { shot, scale, origin, terminal, lineY };
    const background = behindOf(bounds);
    const win = ensurePanel();
    win.setBounds(bounds);
    const payload = { labels: buttons.map((button) => button.label), background };
    if (pageLoaded) reveal(payload);
    else pendingReveal = payload;
  } catch (error) {
    log.出事("Ctrl+Q 弹窗失败", error, "toggle");
  } finally {
    opening = false;
  }
}

/** 窗口身后那一块（按 Ctrl+Q 时截的屏里剪下来），给界面当玻璃底；没截到给空串。 */
function behindOf(bounds: Rect): string {
  if (!lastView?.shot) return "";
  const { shot, scale, origin } = lastView;
  return shot.crop({
    x: Math.round(bounds.x * scale - origin.x),
    y: Math.round(bounds.y * scale - origin.y),
    width: Math.round(bounds.width * scale),
    height: Math.round(bounds.height * scale),
  }).toDataURL();
}

/** 截终端所在那块屏幕，物理像素原大。截不到返回 null（窗口照弹，只是没毛玻璃底、位置用估的）。 */
async function captureDisplay(display: Electron.Display): Promise<NativeImage | null> {
  try {
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
  } catch (error) {
    log.出事("截屏失败（窗口照弹，只是没毛玻璃底）", error, "capture");
    return null;
  }
}

/** 在截图里量终端输入框那条线，换算成 Electron 的坐标；量不到给 null。截图是物理像素。 */
function measureLine(shot: NativeImage, physical: Rect, display: Electron.Display): number | null {
  const scale = display.scaleFactor;
  const area = shot.crop({
    x: Math.round(physical.x - display.bounds.x * scale),
    y: Math.round(physical.y - display.bounds.y * scale),
    width: physical.width,
    height: physical.height,
  });
  const size = area.getSize();
  const found = findInputTopLine({ data: area.toBitmap(), width: size.width, height: size.height });
  return found === null ? null : (physical.y + found) / scale;
}

function reveal(payload: { labels: string[]; background: string }): void {
  pendingReveal = null;
  const win = panel;
  if (!win || win.isDestroyed()) return;
  win.webContents.send("quickcmd:buttons", payload);
  win.showInactive();
  win.setAlwaysOnTop(true, "pop-up-menu");
  startWatching();
}

function hide(): void {
  stopWatching();
  lastView = null;
  try {
    if (panel && !panel.isDestroyed()) panel.hide();
  } catch (error) {
    log.出事("收窗口失败", error, "hide");
  }
}

function startWatching(): void {
  stopWatching();
  mouseWasDown = win32?.mouseDown() ?? false;
  pressStartedInside = false;
  mouseTimer = setInterval(watchMouse, MOUSE_POLL_MS);
  mouseTimer.unref();
  followTimer = setInterval(() => void followLine(), FOLLOW_MS);
  followTimer.unref();
}

function stopWatching(): void {
  if (mouseTimer) clearInterval(mouseTimer);
  if (followTimer) clearInterval(followTimer);
  mouseTimer = null;
  followTimer = null;
}

/** 鼠标在窗口外面按下 → 收（点终端别处、点别的程序都算）。在窗口里按下的（点按钮、拖按钮）不管，拖出窗口外也不收。 */
function watchMouse(): void {
  if (!win32 || !panel || panel.isDestroyed() || !panel.isVisible()) return;
  try {
    const down = win32.mouseDown();
    if (down && !mouseWasDown) {
      const point = win32.cursor();
      const box = screen.dipToScreenRect(panel, panel.getBounds());
      pressStartedInside = !!point && point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
      if (!pressStartedInside) hide();
    }
    mouseWasDown = down;
  } catch (error) {
    log.出事("看鼠标失败（不影响使用）", error, "mouse");
  }
}

/** 开着的时候每秒重量一次那条线：输入框打字变高了，窗口跟着往上挪，别压住字。 */
async function followLine(): Promise<void> {
  if (!win32 || following || !panel || panel.isDestroyed() || !panel.isVisible()) return;
  following = true;
  try {
    const physical = win32.rectOf(target);
    if (!physical) return;
    const display = screen.getDisplayMatching(screen.screenToDipRect(null, physical));
    const shot = await captureDisplay(display);
    if (!shot || !panel || panel.isDestroyed() || !panel.isVisible()) return;
    const lineY = measureLine(shot, physical, display);
    if (lineY === null) return;
    const bounds = computePanelBounds(screen.screenToDipRect(null, physical), buttons.length, lineY);
    const now = panel.getBounds();
    if (Math.abs(now.y - bounds.y) > 1) panel.setBounds(bounds);
  } catch (error) {
    log.出事("跟着输入框挪失败（不影响使用）", error, "follow");
  } finally {
    following = false;
  }
}

/** 拖按钮换位置：第 from 个插到第 to 个的位置，顺序记下来，下次弹出还是这个顺序。功能跟着按钮走。 */
function move(from: number, to: number): void {
  try {
    buttons = moveButton(buttons, from, to);
    writeJsonAtomic(orderPath(), buttons.map((button) => button.id));
    log.记(`按钮换位置：第 ${from + 1} 个插到第 ${to + 1} 个`, "move");
  } catch (error) {
    log.出事("记按钮顺序失败（这次换了，下次弹出可能回到原样）", error, "move");
  }
}

/** 点了第 index 个按钮：打开文件的自己开；别的趁终端还在最前面，替用户按一下它绑的那个键。然后收。 */
function press(index: number): void {
  if (!win32) return;
  try {
    const button = buttons[index];
    if (!button) return;
    if (button.openPath) {
      const path = resolveMovedPath(button.openPath, existsSync);
      if (/\.html?$/i.test(path) && lastView) {
        const bounds = computeSheetBounds(lastView.terminal, lastView.lineY);
        openSheet(path, bounds, behindOf(bounds));
        log.记(`弹说明面板 ${path}（${button.label}）`, "press");
        hide();
        return;
      }
      hide();
      void shell.openPath(path).then((problem) => {
        if (problem) log.出事(`打不开 ${path}：${problem}`, undefined, "press");
        else log.记(`打开了 ${path}（${button.label}）`, "press");
      });
      return;
    }
    if (win32.foreground() !== target) {
      log.记("点按钮时最前面已经不是那个终端了，不按", "press");
      hide();
      return;
    }
    win32.pressKey(button.vk);
    log.记(`替用户按了 ${button.key}（${button.label}）`, "press");
    hide();
  } catch (error) {
    log.出事("按钮没按成", error, "press");
  }
}

function ensurePanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;
  const win = new BrowserWindow({
    width: 166,
    height: 180,
    show: false,
    frame: false,
    // 透明窗口：圆角外面真透明，没有 Windows 描的边和阴影。毛玻璃底是界面自己画的（截的屏 + 模糊）。
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 🚨 从不抢焦点：点按钮时终端得一直在最前面，键才按得到它身上。
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pageLoaded = false;
  win.webContents.once("did-finish-load", () => {
    pageLoaded = true;
    if (pendingReveal) reveal(pendingReveal);
  });
  win.on("closed", () => {
    if (panel === win) panel = null;
  });
  win.webContents.on("render-process-gone", (_event, details) => log.出事(`渲染进程挂了：${details.reason}`, undefined, "window"));
  void win.loadFile(join(__dirname, "renderer", "index.html")).catch((error) => log.出事("页面加载失败", error, "window"));
  panel = win;
  return win;
}
