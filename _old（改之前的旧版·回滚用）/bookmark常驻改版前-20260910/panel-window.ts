// 书签台面板：独立 BrowserWindow + 全局热键 + 本块专属 IPC。
// 🚨 隔离铁律：本块断网/崩溃不许连坐桌宠本体。对外只露出下面三个函数，
// app.ts 装配时调 initBookmarkPanel()；托盘入口经 app.ts 注入 PetTrayActions（pet 块不 import 本块）。

import { join } from "node:path";
import { BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";
import { createLogger } from "../shared/log";
import { AgentRoster } from "./agents";
import { BookmarkStore } from "./store";

const log = createLogger("bookmark");

export const BOOKMARK_HOTKEY = "Alt+S";

// 物理尺寸（跟桌宠一个思路：按主屏 scaleFactor 换算成逻辑像素，跨缩放视觉大小一致）。
// 看板改版（2026-09-10）：分组列表比旧输入+列表高，420×640 → 440×780。
const PANEL_PHYSICAL_WIDTH = 440;
const PANEL_PHYSICAL_HEIGHT = 780;

let panel: BrowserWindow | null = null;
let store: BookmarkStore | null = null;
let roster: AgentRoster | null = null;
let hotkeyRegistered = false;
let pendingShow = false;
let rendererReady = false;

export interface BookmarkPanelOptions {
  /** 注册全局热键。自测模式传 false，别跟真机抢热键。 */
  hotkey?: boolean;
}

/** 装配口：注册 IPC（+ 可选热键）。书签台的任何失败在这里被吞掉记日志，不许往外炸。 */
export function initBookmarkPanel(options?: BookmarkPanelOptions): void {
  if (store) return;
  store = new BookmarkStore();
  roster = new AgentRoster();
  registerIpc();
  if (options?.hotkey) registerHotkey();
  log.记("书签台就绪（Agent 看板）", "init");
}

/** 呼出/收起面板（热键和托盘都走这里）。 */
export function toggleBookmarkPanel(): void {
  try {
    if (!panel) {
      panel = createPanel();
      pendingShow = true;
      if (rendererReady) showAndFocus(panel);
      return;
    }
    if (panel.isVisible()) {
      panel.hide();
      return;
    }
    showAndFocus(panel);
  } catch (error) {
    log.出事("书签台呼出失败", error, "toggle");
  }
}

/** 退出清理：退热键、关窗口。数据在磁盘上，不丢。 */
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
    if (ok) log.记(`全局热键已注册 ${BOOKMARK_HOTKEY}`, "init");
    else log.出事(`全局热键 ${BOOKMARK_HOTKEY} 注册失败（被别的程序占了？书签台仍可从托盘打开）`, undefined, "init");
  } catch (error) {
    log.出事("热键注册异常（书签台仍可从托盘打开）", error, "init");
  }
}

function createPanel(): BrowserWindow {
  rendererReady = false;
  const win = buildWindow();
  win.once("ready-to-show", () => {
    rendererReady = true;
    if (pendingShow) {
      pendingShow = false;
      showAndFocus(win);
    }
  });
  win.on("closed", () => {
    panel = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 面板里不开网页：链接一律丢给系统浏览器。
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadFile(join(__dirname, "renderer", "index.html"));
  return win;
}

function buildWindow(): BrowserWindow {
  const [width, height] = panelLogicalSize();
  const position = defaultPanelBounds(width, height);
  const base = {
    width,
    height,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
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
    log.记("面板已建（acrylic 毛玻璃）", "window");
    return win;
  } catch (error) {
    log.出事("acrylic 毛玻璃不可用，回落无材质半透明", error, "window");
    return new BrowserWindow(base);
  }
}

function showAndFocus(win: BrowserWindow): void {
  clampIntoWorkArea(win);
  win.show();
  win.focus();
}

function panelLogicalSize(): [number, number] {
  const scale = Math.max(1, screen.getPrimaryDisplay().scaleFactor || 1);
  return [
    Math.max(280, Math.round(PANEL_PHYSICAL_WIDTH / scale)),
    Math.max(360, Math.round(PANEL_PHYSICAL_HEIGHT / scale)),
  ];
}

function clampIntoWorkArea(win: BrowserWindow): void {
  const workArea = screen.getPrimaryDisplay().workArea;
  const bounds = win.getBounds();
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height);
  if (x !== bounds.x || y !== bounds.y) win.setBounds({ ...bounds, x, y });
}

function defaultPanelBounds(width: number, height: number): { x: number; y: number } {
  const scale = Math.max(1, screen.getPrimaryDisplay().scaleFactor || 1);
  const workArea = screen.getPrimaryDisplay().workArea;
  const margin = Math.round(24 / scale);
  return {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + Math.max(0, Math.round((workArea.height - height) / 2)),
  };
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

  // ── Agent 看板分组（2026-09-10 改版）：分组清单独立存 agents.json ──
  ipcMain.handle("bookmark:agents", () => requireRoster().list());
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

function normalizeInput(input: unknown): { text: string; url: string | null; assignee: string | null; dedupeKey: string | null } {
  const raw = (input ?? {}) as { text?: unknown; url?: unknown; assignee?: unknown; dedupeKey?: unknown };
  const text = String(raw.text ?? "").trim();
  if (!text) throw new Error("书签内容不能为空");
  return {
    text,
    url: raw.url ? String(raw.url) : null,
    assignee: raw.assignee ? String(raw.assignee) : null,
    dedupeKey: raw.dedupeKey ? String(raw.dedupeKey) : null,
  };
}

