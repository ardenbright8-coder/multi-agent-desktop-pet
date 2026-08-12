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
const PET_VISIBLE_BOUNDS = { x: 218, y: 392, width: 213, height: 247 };
const PET_WINDOW_SHAPE = { x: 205, y: 360, width: 235, height: 320 };

let mainWindow: BrowserWindow | null = null;
let positionBeforePanel: { x: number; y: number } | null = null;
let petPickedUp = false;
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
    ? clampWindowPosition(saved, screen.getAllDisplays().map((display) => display.workArea), WINDOW_SIZE, PET_VISIBLE_BOUNDS)
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
  win.setShape([PET_WINDOW_SHAPE]);
  win.loadFile(join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    win.showInactive();
    win.webContents.send("hub:snapshot", hub.snapshot());
  });
  let saveTimer: NodeJS.Timeout | null = null;
  win.on("move", () => {
    if (positionBeforePanel) return;
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

export function keepWindowOnVisibleDisplay(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (positionBeforePanel) {
    positionBeforePanel = clampWindowPosition(positionBeforePanel, workAreas, WINDOW_SIZE, PET_VISIBLE_BOUNDS);
    const currentPanelPosition = mainWindow.getBounds();
    const visiblePanelPosition = clampWindowPosition(currentPanelPosition, workAreas, WINDOW_SIZE);
    if (visiblePanelPosition.x !== currentPanelPosition.x || visiblePanelPosition.y !== currentPanelPosition.y) {
      mainWindow.setPosition(visiblePanelPosition.x, visiblePanelPosition.y);
    }
    return;
  }
  const current = mainWindow.getBounds();
  const next = clampWindowPosition(current, workAreas, WINDOW_SIZE, PET_VISIBLE_BOUNDS);
  if (next.x !== current.x || next.y !== current.y) mainWindow.setPosition(next.x, next.y);
  persistWindowPosition();
}

export function setPanelVisibility(visible: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (visible) {
    if (positionBeforePanel) return;
    positionBeforePanel = mainWindow.getBounds();
    const next = clampWindowPosition(positionBeforePanel, workAreas, WINDOW_SIZE);
    mainWindow.setPosition(next.x, next.y, false);
    updateWindowShape();
    return;
  }
  if (!positionBeforePanel) return;
  const restore = clampWindowPosition(positionBeforePanel, workAreas, WINDOW_SIZE, PET_VISIBLE_BOUNDS);
  positionBeforePanel = null;
  mainWindow.setPosition(restore.x, restore.y, false);
  persistWindowPosition();
  updateWindowShape();
}

export function setPetPickedUp(pickedUp: boolean): void {
  petPickedUp = pickedUp;
  updateWindowShape();
}

export function moveWindowToPointer(x: number, y: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setPosition(x, y, false);
}

function updateWindowShape(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setShape(positionBeforePanel || petPickedUp ? [{ x: 0, y: 0, ...WINDOW_SIZE }] : [PET_WINDOW_SHAPE]);
}
