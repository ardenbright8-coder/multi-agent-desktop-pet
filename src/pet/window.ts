// 宠物窗口本体：建窗口、显示/隐藏、位置、形状。
// 窗口相关的可变状态（当前窗口、面板前的位置、有没有被拿起、是不是正在退出）全住在这个文件里，
// 别处要用一律走下面导出的那几个口子，不许再各自存一份。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { writeJsonAtomic } from "../shared/atomic-file";
import { preferencesPath } from "../shared/paths";
import type { AgentHub } from "../events/hub";
import { clampWindowPosition, defaultWindowPosition } from "./window-position";

export const WINDOW_SIZE = { width: 440, height: 680 };

let mainWindow: BrowserWindow | null = null;
// panelOpen 是「面板开着没」的唯一真相。
// 🚨 别再拿 positionBeforePanel 是不是 null 来判断——那个值只要漏清一次（渲染层重载、
// 面板走别的路径关掉），面板就再也不会被拉回屏幕内，窗口还会永久卡在不穿透状态继续挡鼠标。
// 2026-08-12 实机踩过：拖出屏幕后弹面板，右半边和确认按钮全在屏幕外。
let panelOpen = false;
let positionBeforePanel: { x: number; y: number } | null = null;
let dragging = false;
let hoveringInteractive = false;
let ignoringMouse = true;
let shuttingDown = false;

export function getPetWindow(): BrowserWindow | null {
  return mainWindow;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function destroyPetWindow(): void {
  mainWindow?.destroy();
  mainWindow = null;
}

export function createPetWindow(hub: AgentHub): BrowserWindow {
  const saved = loadWindowBounds();
  const workArea = screen.getPrimaryDisplay().workArea;
  const fallback = defaultWindowPosition(workArea, WINDOW_SIZE);
  const bounds = saved
    ? clampWindowPosition(saved, screen.getAllDisplays().map((display) => display.workArea), WINDOW_SIZE)
    : fallback;
  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "..", "channel", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认整窗穿透：透明区域绝不许挡住底下的程序。
  // forward:true 让窗口在穿透状态下仍然收得到 mousemove，界面靠它判断鼠标有没有挪到幼苗上，
  // 挪上去了才临时收回穿透（applyMouseMode）。详见本夹 AGENTS.md「为什么不用 setShape」。
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoringMouse = true;
  win.loadFile(join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    win.showInactive();
    win.webContents.send("hub:snapshot", hub.snapshot());
  });
  let saveTimer: NodeJS.Timeout | null = null;
  win.on("move", () => {
    if (panelOpen) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed()) persistWindowPosition();
    }, 300);
  });
  win.on("close", (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      win.hide();
    }
  });
  mainWindow = win;
  return win;
}


// 🚨 算边界一律用这个，别用 WINDOW_SIZE 常量。
// 两个坑叠在一起（2026-08-12 实测，这台机缩放 179%）：
//  ① Windows 给无边框窗口留了一圈不可见边框：建的时候写 440x680，getBounds() 报 456x710。
//  ② 这个尺寸还会飘：同一个窗口挪一下位置，报的是 456x710 还是 461x715 都可能，
//     高 DPI 下的取整所致。
// 拿常量或者拿某一次读到的尺寸去 clamp，右下角就总能露出十几像素在屏幕外，
// 面板右边被切、按钮够不着就有它一份。所以取「设计尺寸和实测尺寸的大者」再加 8px 余量。
const EDGE_SAFETY = 8;

function safeWindowSize(): { width: number; height: number } {
  if (!mainWindow || mainWindow.isDestroyed()) return WINDOW_SIZE;
  const { width, height } = mainWindow.getBounds();
  return {
    width: Math.max(WINDOW_SIZE.width, width) + EDGE_SAFETY,
    height: Math.max(WINDOW_SIZE.height, height) + EDGE_SAFETY,
  };
}

export function watchDisplayChanges(): void {
  screen.on("display-added", keepWindowOnVisibleDisplay);
  screen.on("display-removed", keepWindowOnVisibleDisplay);
  screen.on("display-metrics-changed", keepWindowOnVisibleDisplay);
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.showInactive();
}

export function hideMainWindow(): void {
  mainWindow?.hide();
}

function loadWindowBounds(): { x: number; y: number } | null {
  try {
    if (!existsSync(preferencesPath())) return null;
    const value = JSON.parse(readFileSync(preferencesPath(), "utf8")) as { x?: unknown; y?: unknown };
    return Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x as number, y: value.y as number } : null;
  } catch {
    return null;
  }
}

export function persistWindowPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = mainWindow.getBounds();
  writeJsonAtomic(preferencesPath(), { x, y });
}

// 整个窗口一律锁在工作区内。用户 2026-08-12 明确要求「框不要超出屏幕」——
// 以前只保证幼苗那一小块可见，窗口大半在屏幕外，结果面板一弹出来右半边和按钮就够不着。
export function keepWindowOnVisibleDisplay(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const size = safeWindowSize();
  if (panelOpen && positionBeforePanel) {
    positionBeforePanel = clampWindowPosition(positionBeforePanel, workAreas, size);
  }
  const current = mainWindow.getBounds();
  const next = clampWindowPosition(current, workAreas, size);
  if (next.x !== current.x || next.y !== current.y) mainWindow.setPosition(next.x, next.y);
  persistWindowPosition();
}

export function setPanelVisibility(visible: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (visible) {
    // 记一次面板前的落脚点（已经记过就不覆盖），然后每次都把整窗拉回屏幕内——
    // 幂等，重复调没坏处，漏调才要命。
    if (!positionBeforePanel) positionBeforePanel = mainWindow.getBounds();
    panelOpen = true;
    ensureFullyVisible();
    applyMouseMode();
    return;
  }
  panelOpen = false;
  if (!positionBeforePanel) {
    applyMouseMode();
    return;
  }
  const restore = clampWindowPosition(positionBeforePanel, workAreas, safeWindowSize());
  positionBeforePanel = null;
  mainWindow.setPosition(restore.x, restore.y, false);
  persistWindowPosition();
  applyMouseMode();
}

// 把幼苗叫回默认位置（右下角）。拖丢了、跑到看不见的地方了，托盘菜单点一下就回来。
export function recallPetWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workArea = screen.getPrimaryDisplay().workArea;
  const home = defaultWindowPosition(workArea, safeWindowSize());
  mainWindow.setPosition(home.x, home.y, false);
  mainWindow.showInactive();
  persistWindowPosition();
}

// 把整个窗口拉进屏幕（不是只保证幼苗可见）。面板要显示时必须这样，
// 否则面板的右半边和底部那排按钮会留在屏幕外，人点不着确认。
export function ensureFullyVisible(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const current = mainWindow.getBounds();
  const next = clampWindowPosition(current, workAreas, safeWindowSize());
  if (next.x !== current.x || next.y !== current.y) mainWindow.setPosition(next.x, next.y, false);
}

// 拖动：主进程自己读系统光标位置来挪窗口，不用界面传过来的坐标。
// 🚨 为什么不能用界面的 event.screenX/screenY：那是**物理像素**，而 setPosition 要的是 DIP。
// 这台机缩放 179%，两者差 1.79 倍 —— 越往下拖，窗口被送去的 DIP 坐标越离谱，
// 一拖就漂出屏幕底部再也找不着（2026-08-12 实机踩的）。
// screen.getCursorScreenPoint() 返回的就是 DIP，跟 setPosition 单位天生一致。
let dragOffset = { x: 0, y: 0 };
let dragTimer: NodeJS.Timeout | null = null;

export function startDragging(offset: { x: number; y: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dragOffset = {
    x: Number.isFinite(offset?.x) ? offset.x : WINDOW_SIZE.width / 2,
    y: Number.isFinite(offset?.y) ? offset.y : WINDOW_SIZE.height / 2,
  };
  dragging = true;
  applyMouseMode();
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => dragTick(screen.getCursorScreenPoint()), 16);
}

export function stopDragging(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragging = false;
  applyMouseMode();
  persistWindowPosition();
}

// 按光标位置挪一格。整窗一律锁在工作区内——用户明确要求「框不要超出屏幕」，
// 这样面板弹出来也永远是完整的。导出是为了自测能直接喂坐标，不然测不了真实光标。
export function dragTick(cursor: { x: number; y: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const target = clampWindowPosition({ x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y }, workAreas, safeWindowSize());
  const current = mainWindow.getBounds();
  if (target.x !== current.x || target.y !== current.y) mainWindow.setPosition(target.x, target.y, false);
}

export function setHoveringInteractive(value: boolean): void {
  hoveringInteractive = value;
  applyMouseMode();
}

export function isDragging(): boolean {
  return dragging;
}

// 给自测用：现在窗口是不是让开鼠标的（true = 底下的程序点得到）。
export function isIgnoringMouse(): boolean {
  return ignoringMouse;
}

// 什么时候该收回穿透：面板开着、正在拖、或者鼠标正压在可点的东西上。
// 其余时候一律穿透，透明区域不许挡住底下的程序。
function applyMouseMode(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const shouldIgnore = !(panelOpen || dragging || hoveringInteractive);
  if (shouldIgnore === ignoringMouse) return;
  ignoringMouse = shouldIgnore;
  if (shouldIgnore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
  else mainWindow.setIgnoreMouseEvents(false);
}
