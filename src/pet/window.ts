// 宠物窗口本体：建窗口、显示/隐藏、位置、形状。
// 窗口相关的可变状态（当前窗口、面板前的位置、有没有被拿起、是不是正在退出）全住在这个文件里，
// 别处要用一律走下面导出的那几个口子，不许再各自存一份。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { writeJsonAtomic } from "../shared/atomic-file";
import { preferencesPath } from "../shared/paths";
import { createLogger } from "../shared/log";
import type { AgentHub } from "../events/hub";
import { clampWindowPosition, defaultWindowPosition } from "./window-position";

// 平时窗口只有幼苗那么大，面板要弹的时候才临时长大。
// 🚨 为什么必须这样（2026-08-12 实机）：这台机 3440x1440 缩放 179%，
// Electron 眼里的工作区只有 1922x778 高。窗口按面板尺寸做成 680 高（算上系统边框 710+），
// 上下就只剩 60 像素能挪 —— 用户拖起来是「只能左右平移，上下动不了」。
// 缩成幼苗大小后，上下能挪 470+，整屏随便跑。
// 界面 CSS 一行没改：幼苗区是 right/bottom 定位的，窗口一缩它自然贴在小窗口右下角。
export const PET_WINDOW_SIZE = { width: 220, height: 304 };
export const PANEL_WINDOW_SIZE = { width: 440, height: 680 };
export const WINDOW_SIZE = PET_WINDOW_SIZE;

// 面板尺寸减幼苗尺寸 = 长大时要往左上让出多少，这样幼苗在屏幕上的位置不跳。
const GROW_X = PANEL_WINDOW_SIZE.width - PET_WINDOW_SIZE.width;
const GROW_Y = PANEL_WINDOW_SIZE.height - PET_WINDOW_SIZE.height;

const log = createLogger("window");

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
  const fallback = defaultWindowPosition(workArea, PET_WINDOW_SIZE);
  const bounds = saved
    ? clampWindowPosition(saved, screen.getAllDisplays().map((display) => display.workArea), PET_WINDOW_SIZE)
    : fallback;
  const win = new BrowserWindow({
    ...PET_WINDOW_SIZE,
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
  const area = screen.getPrimaryDisplay().workArea;
  log.记(`建窗口 位置=${bounds.x},${bounds.y} 尺寸=${PET_WINDOW_SIZE.width}x${PET_WINDOW_SIZE.height} 工作区=${area.width}x${area.height} 缩放=${screen.getPrimaryDisplay().scaleFactor}`, "createPetWindow");
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
  const design = panelOpen ? PANEL_WINDOW_SIZE : PET_WINDOW_SIZE;
  if (!mainWindow || mainWindow.isDestroyed()) return design;
  const { width, height } = mainWindow.getBounds();
  return {
    width: Math.max(design.width, width) + EDGE_SAFETY,
    height: Math.max(design.height, height) + EDGE_SAFETY,
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
  // 🚨 面板开着时窗口是「长大」状态，坐标跟幼苗待的地方不是一回事。
  // 存了它，下次启动就拿这个坐标去摆小窗口，幼苗开机即跑偏（2026-08-12 日志抓到的）。
  if (panelOpen) return;
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
    if (panelOpen) {
      ensureFullyVisible();
      return;
    }
    // 记住幼苗现在站在哪，长大时往左上让出面板那部分，幼苗在屏幕上原地不动。
    const before = mainWindow.getBounds();
    positionBeforePanel = { x: before.x, y: before.y };
    panelOpen = true;
    mainWindow.setBounds({
      x: before.x - GROW_X,
      y: before.y - GROW_Y,
      width: PANEL_WINDOW_SIZE.width,
      height: PANEL_WINDOW_SIZE.height,
    }, false);
    ensureFullyVisible();
    log.记(`面板展开，窗口长大 ${before.x},${before.y} → ${mainWindow.getBounds().x},${mainWindow.getBounds().y}`, "setPanelVisibility");
    applyMouseMode();
    return;
  }
  if (!panelOpen) {
    applyMouseMode();
    return;
  }
  panelOpen = false;
  // 缩回幼苗大小：拿当前窗口的右下角当锚，幼苗照样不跳。
  const current = mainWindow.getBounds();
  const shrunk = clampWindowPosition(
    { x: current.x + GROW_X, y: current.y + GROW_Y },
    workAreas,
    { width: PET_WINDOW_SIZE.width + EDGE_SAFETY, height: PET_WINDOW_SIZE.height + EDGE_SAFETY },
  );
  mainWindow.setBounds({ x: shrunk.x, y: shrunk.y, ...PET_WINDOW_SIZE }, false);
  log.记(`面板收起，窗口缩回 ${shrunk.x},${shrunk.y}`, "setPanelVisibility");
  positionBeforePanel = null;
  persistWindowPosition();
  applyMouseMode();
}

// 把幼苗叫回默认位置（右下角）。拖丢了、跑到看不见的地方了，托盘菜单点一下就回来。
export function recallPetWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  log.记("用户从托盘把幼苗叫回来了", "recallPetWindow");
  const workArea = screen.getPrimaryDisplay().workArea;
  const home = defaultWindowPosition(workArea, panelOpen ? safeWindowSize() : PET_WINDOW_SIZE);
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
  if (next.x !== current.x || next.y !== current.y) {
    log.记(`窗口越界被拉回 ${current.x},${current.y} → ${next.x},${next.y}`, "ensureFullyVisible");
    mainWindow.setPosition(next.x, next.y, false);
  }
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
  log.记(`开始拖动 抓手偏移=${Math.round(Number(offset?.x))},${Math.round(Number(offset?.y))}`, "startDragging");
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
  const landed = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  if (landed) log.记(`放下 落点=${landed.x},${landed.y}`, "stopDragging");
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
  log.调试(`鼠标模式 → ${shouldIgnore ? "让开（底下点得到）" : "接管（可点桌宠）"} 面板=${panelOpen} 拖动=${dragging} 悬停=${hoveringInteractive}`, "applyMouseMode");
  if (shouldIgnore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
  else mainWindow.setIgnoreMouseEvents(false);
}
