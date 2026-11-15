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
import { PanelFocusTracker, loadPetFocusWin32, readWindowHwnd } from "./panel-focus";

// 平时窗口只有幼苗那么大，面板要弹的时候才临时长大。
// 🚨 为什么必须这样（2026-08-12 实机）：这台机 3440x1440 缩放 179%，
// Electron 眼里的工作区只有 1922x778 高。窗口按面板尺寸做成 680 高（算上系统边框 710+），
// 上下就只剩 60 像素能挪 —— 用户拖起来是「只能左右平移，上下动不了」。
// 缩成幼苗大小后，上下能挪 470+，整屏随便跑。
// 界面 CSS 一行没改：幼苗区是 right/bottom 定位的，窗口一缩它自然贴在小窗口右下角。
// 幼苗和状态框左右并排，尺寸按**幼苗放到最大（140%）**算，否则放大后会长出窗口，
// 溢出的那块会把本该穿透的角落也占掉（2026-08-12 实测踩到）。
//   宽 = 14 + 152×1.4 + 8 + 188 + 8 ≈ 435
//   高 = 8 + 176×1.4 + 8 ≈ 265  ← 2026-08-13 加「各Agent状态气泡条」后长到 410。
//   v0.1.23 气泡条改成「座位环境」，第二版：窗口背景 = 用户原型图（像素教室 1672×941 ≈ 1.78:1），
//   9 个座位对齐图里 9 套工位。窗口 760 宽 = 左侧 640 教室图（≈1.78:1 几乎无变形）+ 右侧 120 透明区放幼苗。
//   v0.1.23 第三版（2026-08-14 用户定规格）：窗口是右上角小浮窗，**物理尺寸固定 480×270**，
//   按 display.scaleFactor 换算 Electron 逻辑像素（Windows 100%/125%/150%/自定义缩放看到的窗口面积基本一致）。
//   🚨 高度 270 不是随手定的：**必须和场景图 1672×941 同比例**（480 × 941 ÷ 1672 = 270.1）。
//   早先是 290，比例 1.655 对不上图的 1.778，`object-fit: contain` 之后图只有 480×270，
//   上下各空 10px，而画框的圆角和阴影是按 290 高画的 → 木框四角和窗口边错开，
//   看着就是「背景错位」（2026-08-14 用户报的）。改高度比改 CSS 干净：图正好铺满窗口。
//   👉 以后要换背景图，**同时改这里的高度**，别让两边比例再分家。
//   2026-10-01 用户嫌太大：背景裁成 6 座（1672×721），窗口物理 **400×173**（400 × 721 ÷ 1672 = 172.5）。
//   ⚠️ screen 在 app ready 前访问会挂（Electron 限制），所以这里只给默认值（100% 缩放），
//   真实值在 createPetWindow 里按 scaleFactor 重算（见 ensurePetWindowSize）。
let PET_SCALE = 1;
export let PET_WINDOW_SIZE = { width: 400, height: 173 };
export const PET_PHYSICAL_MARGIN = 16; // 距工作区顶部/右侧的物理像素

/** 按当前主屏 scaleFactor 重算窗口逻辑尺寸（物理 400×173，= 场景图 1672×721 同比例）。 */
function ensurePetWindowSize(): void {
  PET_SCALE = Math.max(1, screen.getPrimaryDisplay().scaleFactor || 1);
  PET_WINDOW_SIZE = {
    width: Math.max(100, Math.round(400 / PET_SCALE)),
    height: Math.max(60, Math.round(173 / PET_SCALE)),
  };
}
// 面板窗口最高 740（这台机工作区 778）。抽屉、设置用满高；
// 询问／权限／完成面板由界面量好内容高度传过来，内容少窗口就矮（2026-10-01，用户嫌面板挡东西）。
export const PANEL_WINDOW_SIZE = { width: 400, height: 740 };
const PANEL_MIN_HEIGHT = 140;
const PANEL_HEIGHT_JITTER = 2;
let panelHeight = PANEL_WINDOW_SIZE.height;

function fitPanelHeight(requested?: number): number {
  if (!Number.isFinite(requested)) return PANEL_WINDOW_SIZE.height;
  return Math.min(PANEL_WINDOW_SIZE.height, Math.max(PANEL_MIN_HEIGHT, Math.round(requested as number)));
}

// 面板往**下**长：窗口左上角不动，幼苗贴在窗口顶部，所以它纹丝不动。
// （早先是往左上长，那时幼苗贴窗口底部；改成顶部对齐后必须跟着反过来，
//  否则一弹面板幼苗就往上跳 400 多像素。2026-08-12）

const log = createLogger("window");

let mainWindow: BrowserWindow | null = null;
// panelOpen 是「面板开着没」的唯一真相。
// 🚨 别再拿 positionBeforePanel 是不是 null 来判断——那个值只要漏清一次（渲染层重载、
// 面板走别的路径关掉），面板就再也不会被拉回屏幕内，窗口还会永久卡在不穿透状态继续挡鼠标。
// 2026-08-12 实机踩过：拖出屏幕后弹面板，右半边和确认按钮全在屏幕外。
let panelOpen = false;
// 藏着时来了要点的事（权限／提问），临时亮出来；面板收起再藏回去，「藏起来」那个设置不动（2026-10-31）。
let shownForPanel = false;
let positionBeforePanel: { x: number; y: number } | null = null;
let dragging = false;
let hoveringInteractive = false;
let ignoringMouse = true;
let shuttingDown = false;
let keepOnTopTimer: NodeJS.Timeout | null = null;

const panelFocus = new PanelFocusTracker({
  getWin32: loadPetFocusWin32,
  getSelfHwnd: () => (mainWindow && !mainWindow.isDestroyed() ? readWindowHwnd(mainWindow.getNativeWindowHandle()) : 0n),
  focusPetWindow: (steal) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.moveTop();
    if (!steal) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  },
});

/** 点击「返回终端」主动切去 Agent 窗口时调用，防止紧随而来的关面板动作再把焦点还给更早的旧窗口。 */
export function skipPanelFocusRestore(): void {
  panelFocus.markSkipRestore();
}

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
  if (keepOnTopTimer) {
    clearInterval(keepOnTopTimer);
    keepOnTopTimer = null;
  }
  panelFocus.reset();
  mainWindow?.destroy();
  mainWindow = null;
}

export function createPetWindow(hub: AgentHub): BrowserWindow {
  ensurePetWindowSize(); // 按主屏缩放重算窗口尺寸（物理 400×173 → 逻辑）
  const saved = loadWindowBounds();
  const workArea = screen.getPrimaryDisplay().workArea;
  const margin = Math.round(PET_PHYSICAL_MARGIN / PET_SCALE);
  const fallback = defaultWindowPosition(workArea, PET_WINDOW_SIZE, margin);
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
  // 永远压在最前面（用户 2026-08-12 要求）。
  // "screen-saver" 是 Electron 能给的最高层级，比 "floating" 更难被别的置顶窗口盖住；
  // 再加一道定时重申——有些全屏程序/别的 topmost 窗口会把它挤下去，光设一次守不住。
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认整窗穿透：透明区域绝不许挡住底下的程序。
  // forward:true 让窗口在穿透状态下仍然收得到 mousemove，界面靠它判断鼠标有没有挪到幼苗上，
  // 挪上去了才临时收回穿透（applyMouseMode）。详见本夹 AGENTS.md「为什么不用 setShape」。
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoringMouse = true;
  win.loadFile(join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // 关掉页面缩放：用户误按 Ctrl +/- 会把整个桌宠缩放得莫名其妙，
  // 而幼苗大小本来就有设置里的滑杆，不需要第二套（2026-08-12 用户提的）。
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { /* 老版本没这 API 就算了 */ });
  win.webContents.setZoomFactor(1);
  win.webContents.on("zoom-changed", () => win.webContents.setZoomFactor(1));
  win.webContents.on("before-input-event", (event, input) => {
    if (!input.control && !input.meta) return;
    if (["+", "-", "=", "0", "_", "Add", "Subtract"].includes(input.key)) event.preventDefault();
  });
  win.once("ready-to-show", () => {
    if (!petHiddenNow()) win.showInactive(); // 上次托盘点了「藏起来」：开机照样藏着（2026-10-27）
    win.webContents.send("hub:snapshot", hub.snapshot());
    win.webContents.send("pet:note-side", noteSide);
    syncNoteSide();
  });
  let saveTimer: NodeJS.Timeout | null = null;
  win.on("move", () => {
    if (panelOpen) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed()) persistWindowPosition();
    }, 300);
  });
  // 被系统或 Alt+F4 关窗：当成「隐藏桌宠」记下来，托盘那项跟着变「找回桌宠」。
  // 以前只 hide 不记，托盘还写着「隐藏桌宠」，桌宠却不见了，看着像自己没了（2026-11-04）。
  win.on("close", (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      log.记("窗口被关，按「隐藏桌宠」处理", "close");
      hideMainWindow();
    }
  });
  // 界面那半边崩了：窗口还在、里面全透明，看着就是「桌宠没了」，面板也弹不出来。重载一次救回来。
  win.webContents.on("render-process-gone", (_event, details) => {
    log.出事(`桌宠界面挂了：${details.reason}，重新载入`, undefined, "render-process-gone");
    if (!win.isDestroyed() && !shuttingDown) win.loadFile(join(__dirname, "renderer", "index.html"));
  });
  win.on("unresponsive", () => log.出事("桌宠界面卡住没响应", undefined, "unresponsive"));
  mainWindow = win;
  // 置顶标记还在、窗口却被别的置顶窗口压到底下时，isAlwaysOnTop() 照样报 true，
  // 所以光查标记守不住，每次再 moveTop() 把它提回最上层（不抢焦点）。2026-11-04 用户报「桌宠不在最前面」。
  keepOnTopTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || dragging) return;
    if (!mainWindow.isAlwaysOnTop()) {
      mainWindow.setAlwaysOnTop(true, "screen-saver");
      log.记("有别的窗口把桌宠挤下去了，已重新置顶", "keepOnTop");
    }
    mainWindow.moveTop();
  }, 3_000);
  keepOnTopTimer.unref();
  win.on("blur", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(true, "screen-saver");
  });
  const area = screen.getPrimaryDisplay().workArea;
  log.记(`建窗口 位置=${bounds.x},${bounds.y} 尺寸=${PET_WINDOW_SIZE.width}x${PET_WINDOW_SIZE.height} 工作区=${area.width}x${area.height} 缩放=${screen.getPrimaryDisplay().scaleFactor}`, "createPetWindow");
  return win;
}


// 🚨 算边界一律用设计尺寸，**绝对不许拿 getBounds() 的实测尺寸当基准**。
// 2026-08-12 血的教训（靠日志抓到）：这台机缩放 179%（非整数），Electron 每次 setPosition
// 都会把窗口尺寸四舍五入涨一点点；上一版拿实测尺寸当基准去算边界，涨了之后又被当成新基准，
// 自己喂自己滚雪球 —— 窗口从 220x304 一路长到 940x961。
// 长过屏幕高度后，clamp 算出的上界比下界还小，窗口被一路推出屏幕顶部，
// 用户看到的就是「只能往下拖，永远上不去」。
// 配套措施：所有挪窗口的地方都用 setBounds 带着尺寸一起写，把尺寸钉死（见 fixedBounds）。
const EDGE_SAFETY = 8;

function designSize(): { width: number; height: number } {
  return panelOpen ? { width: PANEL_WINDOW_SIZE.width, height: panelHeight } : PET_WINDOW_SIZE;
}

function safeWindowSize(): { width: number; height: number } {
  const design = designSize();
  return { width: design.width + EDGE_SAFETY, height: design.height + EDGE_SAFETY };
}

/** 挪窗口一律走这儿：位置照给，尺寸每次钉回设计值，不给它膨胀的机会。 */
function moveTo(x: number, y: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds({ x, y, ...designSize() }, false);
  syncNoteSide();
}

// 状态框摆哪边：幼苗在屏幕左半边就把框放右边，在右半边就放左边——
// 让框始终朝屏幕中间展开，不会顶到屏幕外，也不挡幼苗（用户 2026-08-12 提的）。
// 用户手动换过边就以手动的为准，不再自动翻。
let noteSide: "left" | "right" = "right";
let noteSidePinned = false;

function syncNoteSide(): void {
  if (!mainWindow || mainWindow.isDestroyed() || noteSidePinned) return;
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const petCenter = bounds.x + bounds.width / 2;
  const side = petCenter < area.x + area.width / 2 ? "right" : "left";
  if (side === noteSide) return;
  noteSide = side;
  log.记(`状态框换到幼苗${side === "right" ? "右" : "左"}边`, "syncNoteSide");
  mainWindow.webContents.send("pet:note-side", noteSide);
}

/** 托盘里那个「聊天框换个边」。手动换过就钉住，不再自动翻。 */
export function flipNoteSide(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  noteSide = noteSide === "right" ? "left" : "right";
  noteSidePinned = true;
  log.记(`用户手动把状态框换到幼苗${noteSide === "right" ? "右" : "左"}边（之后不再自动翻）`, "flipNoteSide");
  mainWindow.webContents.send("pet:note-side", noteSide);
}

export function currentNoteSide(): "left" | "right" {
  return noteSide;
}

/** 托盘的「详情 / 设置」要让界面开对应面板。 */
export function sendPetCommand(command: "drawer" | "settings"): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showMainWindow();
  mainWindow.webContents.send("pet:command", command);
}

export function watchDisplayChanges(): void {
  screen.on("display-added", keepWindowOnVisibleDisplay);
  screen.on("display-removed", keepWindowOnVisibleDisplay);
  screen.on("display-metrics-changed", keepWindowOnVisibleDisplay);
}

// 藏起来 / 显示记长久（2026-10-27 用户：选了藏就一直藏，放开就一直放开，开机关机不重置）。
// 存在 preferences.json 的 hidden，跟幼苗位置一份文件；托盘「显示桌宠」、点托盘图标、叫回来、开详情都算放开。
// 用到才读（模块一加载就读，数据夹可能还没定好）。
let hiddenCache: boolean | null = null;
function petHiddenNow(): boolean {
  if (hiddenCache === null) hiddenCache = readPreferences().hidden === true;
  return hiddenCache;
}
function rememberHidden(hidden: boolean): void {
  if (petHiddenNow() === hidden) return;
  hiddenCache = hidden;
  savePreferences({ hidden });
}

/** 托盘那对开关读这个：藏着就显示「找回桌宠」，露着显示「隐藏桌宠」。 */
export function isPetHidden(): boolean {
  return petHiddenNow();
}

/** 托盘开关：true＝藏起来并记住（开机也藏），false＝出来并记住。 */
export function setPetHidden(hidden: boolean): void {
  if (hidden) hideMainWindow();
  else showMainWindow();
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.showInactive();
  shownForPanel = false;
  rememberHidden(false);
}

/**
 * 藏着时：询问／权限窗露着就临时亮出来；换成完成提醒、设置这些就藏回去（藏着就是不想被它打扰）。
 * 看的是界面上那个窗露没露，不看后台有没有待处理——他按 Esc／关闭关掉的，后台还挂着，不能再被它叫出来（2026-10-31）。
 */
function syncHiddenReveal(needsAction: boolean, focusPanel = false): void {
  if (!mainWindow || mainWindow.isDestroyed() || !petHiddenNow()) return;
  if (needsAction && !mainWindow.isVisible()) {
    if (focusPanel) mainWindow.show();
    else mainWindow.showInactive();
    shownForPanel = true;
    log.记("藏着时来了要点的事，临时亮出来", "setPanelVisibility");
  } else if (!needsAction && shownForPanel) {
    mainWindow.hide();
    shownForPanel = false;
  }
}

export function hideMainWindow(): void {
  panelFocus.sync(false);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pet:command", "close-overlays");
    mainWindow.hide();
  }
  rememberHidden(true);
}

function readPreferences(): { x?: unknown; y?: unknown; panelX?: unknown; panelY?: unknown; hidden?: unknown } {
  try {
    if (!existsSync(preferencesPath())) return {};
    return JSON.parse(readFileSync(preferencesPath(), "utf8")) as { x?: unknown; y?: unknown; panelX?: unknown; panelY?: unknown; hidden?: unknown };
  } catch {
    return {};
  }
}

/** 只改给的那几项，别的照旧（存位置别把「藏起来」冲掉）。 */
function savePreferences(patch: { x?: number; y?: number; panelX?: number; panelY?: number; hidden?: boolean }): void {
  writeJsonAtomic(preferencesPath(), { ...readPreferences(), ...patch });
}

function loadWindowBounds(): { x: number; y: number } | null {
  const value = readPreferences();
  return Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x as number, y: value.y as number } : null;
}

function loadPanelBounds(): { x: number; y: number } | null {
  const value = readPreferences();
  return Number.isFinite(value.panelX) && Number.isFinite(value.panelY)
    ? { x: value.panelX as number, y: value.panelY as number }
    : null;
}

/** 弹窗默认落点：最右那块屏幕的右侧、垂直约 2/3 高度处（2026-11-01 用户拍板）。 */
function defaultPanelPosition(height: number): { x: number; y: number } {
  const displays = screen.getAllDisplays();
  const area = displays.length
    ? displays.reduce((best, cur) =>
        (cur.workArea.x + cur.workArea.width > best.workArea.x + best.workArea.width ? cur : best),
      ).workArea
    : screen.getPrimaryDisplay().workArea;
  const margin = Math.round(PET_PHYSICAL_MARGIN / PET_SCALE);
  const x = area.x + area.width - PANEL_WINDOW_SIZE.width - margin;
  const y = area.y + Math.round((area.height * 2) / 3) - Math.round(height / 2);
  const workAreas = displays.length ? displays.map((d) => d.workArea) : [area];
  return clampWindowPosition(
    { x, y },
    workAreas,
    { width: PANEL_WINDOW_SIZE.width + EDGE_SAFETY, height: height + EDGE_SAFETY },
  );
}

export function persistWindowPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 🚨 面板开着时窗口是「长大」状态，坐标跟幼苗待的地方不是一回事。
  // 存了它，下次启动就拿这个坐标去摆小窗口，幼苗开机即跑偏（2026-08-12 日志抓到的）。
  if (panelOpen) return;
  const { x, y } = mainWindow.getBounds();
  savePreferences({ x, y });
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
  if (next.x !== current.x || next.y !== current.y) moveTo(next.x, next.y);
  persistWindowPosition();
}

export function setPanelVisibility(visible: boolean, height?: number, needsAction = false, focusPanel = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (visible) {
    const nextHeight = fitPanelHeight(height);
    if (panelOpen) {
      // 面板开着换了内容（比如完成面板换成权限面板），高度跟着换，左上角不动
      // 差 2 像素以内不改：那是缩放取整的零头，跟着改会一点点滚大（2026-11-04）
      if (Math.abs(nextHeight - panelHeight) > PANEL_HEIGHT_JITTER) {
        panelHeight = nextHeight;
        const current = mainWindow.getBounds();
        moveTo(current.x, current.y);
        log.记(`面板换内容，窗口高度改成 ${panelHeight}`, "setPanelVisibility");
      }
      ensureFullyVisible();
      syncHiddenReveal(needsAction, focusPanel);
      applyMouseMode();
      panelFocus.sync(focusPanel);
      return;
    }
    const before = mainWindow.getBounds();
    positionBeforePanel = { x: before.x, y: before.y };
    panelOpen = true;
    panelHeight = nextHeight;
    const savedPanel = loadPanelBounds();
    const target = savedPanel
      ? clampWindowPosition(savedPanel, workAreas, safeWindowSize())
      : defaultPanelPosition(panelHeight);
    mainWindow.setBounds({
      x: target.x,
      y: target.y,
      width: PANEL_WINDOW_SIZE.width,
      height: panelHeight,
    }, false);
    ensureFullyVisible();
    log.记(`面板展开，窗口长大 ${before.x},${before.y} → ${mainWindow.getBounds().x},${mainWindow.getBounds().y} 高 ${panelHeight}`, "setPanelVisibility");
    applyMouseMode();
    syncHiddenReveal(needsAction, focusPanel);
    panelFocus.sync(focusPanel);
    return;
  }
  // 交互面板收起前先趁窗还露着时判断当前前台是不是桌宠，是才把焦点还回原来的窗，然后再 hide
  panelFocus.sync(false);
  if (!panelOpen) {
    applyMouseMode();
    return;
  }
  panelOpen = false;
  if (shownForPanel) {
    shownForPanel = false;
    if (petHiddenNow()) mainWindow.hide();
  }
  // 缩回幼苗大小并归还面板展开前的位置。
  const base = positionBeforePanel ?? mainWindow.getBounds();
  const shrunk = clampWindowPosition(
    { x: base.x, y: base.y },
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
  log.记("用户从托盘把桌宠叫回默认位置", "recallPetWindow");
  const workArea = screen.getPrimaryDisplay().workArea;
  const margin = Math.round(PET_PHYSICAL_MARGIN / PET_SCALE);
  const home = defaultWindowPosition(workArea, designSize(), margin);
  moveTo(home.x, home.y);
  showMainWindow();
  persistWindowPosition();
}

// 把整个窗口拉进屏幕（不是只保证幼苗可见）。面板要显示时必须这样，
// 否则面板的右半边和底部那排按钮会留在屏幕外，人点不着确认。
export function ensureFullyVisible(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const current = mainWindow.getBounds();
  const next = clampWindowPosition(current, workAreas, safeWindowSize());
  if (next.x !== current.x || next.y !== current.y || current.width !== designSize().width || current.height !== designSize().height) {
    log.记(`窗口归位 ${current.x},${current.y} ${current.width}x${current.height} → ${next.x},${next.y} ${designSize().width}x${designSize().height}`, "ensureFullyVisible");
    moveTo(next.x, next.y);
  }
}

// 拖动：主进程自己读系统光标位置来挪窗口，不用界面传过来的坐标。
// 🚨 为什么不能用界面的 event.screenX/screenY：那是**物理像素**，而 setPosition 要的是 DIP。
// 这台机缩放 179%，两者差 1.79 倍 —— 越往下拖，窗口被送去的 DIP 坐标越离谱，
// 一拖就漂出屏幕底部再也找不着（2026-08-12 实机踩的）。
// screen.getCursorScreenPoint() 返回的就是 DIP，跟 setPosition 单位天生一致。
let dragOffset = { x: 0, y: 0 };
let dragTimer: NodeJS.Timeout | null = null;

export function startDragging(offset: { x: number; y: number }, diagnostics?: Record<string, unknown>): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const content = mainWindow.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  log.记(
    `开始拖动 抓手偏移=${Math.round(Number(offset?.x))},${Math.round(Number(offset?.y))}`
    + ` 窗口=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
    + ` 内容区=${content.x},${content.y} ${content.width}x${content.height}`
    + ` 光标=${cursor.x},${cursor.y}`
    + (diagnostics ? ` 界面报=视口${diagnostics.viewportW}x${diagnostics.viewportH} dpr=${diagnostics.dpr} 幼苗@${diagnostics.petLeft},${diagnostics.petTop} ${diagnostics.petW}x${diagnostics.petH}` : ""),
    "startDragging",
  );
  dragOffset = {
    x: Number.isFinite(offset?.x) ? offset.x : PET_WINDOW_SIZE.width / 2,
    y: Number.isFinite(offset?.y) ? offset.y : PET_WINDOW_SIZE.height / 2,
  };
  dragging = true;
  applyMouseMode();
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => dragTick(screen.getCursorScreenPoint()), 16);
}

export function stopDragging(): void {
  const landed = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  if (landed) log.记(`放下 落点=${landed.x},${landed.y} 尺寸=${landed.width}x${landed.height}`, "stopDragging");
  tickCount = 0;
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragging = false;
  applyMouseMode();
  if (panelOpen && landed) {
    savePreferences({ panelX: landed.x, panelY: landed.y });
  } else {
    persistWindowPosition();
  }
}

// 按光标位置挪一格。整窗一律锁在工作区内——用户明确要求「框不要超出屏幕」，
// 这样面板弹出来也永远是完整的。导出是为了自测能直接喂坐标，不然测不了真实光标。
let tickCount = 0;

export function dragTick(cursor: { x: number; y: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const wanted = { x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y };
  const size = safeWindowSize();
  const target = clampWindowPosition(wanted, workAreas, size);
  const current = mainWindow.getBounds();
  tickCount += 1;
  if (tickCount % 30 === 0) {
    log.记(`拖动中 光标=${cursor.x},${cursor.y} 想去=${Math.round(wanted.x)},${Math.round(wanted.y)} 实际=${target.x},${target.y} 现在=${current.x},${current.y} 用的尺寸=${size.width}x${size.height}`, "dragTick");
  }
  moveTo(target.x, target.y);
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

/** 排障用：为什么现在是这个鼠标模式。 */
export function mouseModeState(): string {
  return `让开=${ignoringMouse} 面板=${panelOpen} 拖动=${dragging} 悬停可点=${hoveringInteractive}`;
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
