// 说明面板（2026-10-17 用户要的）：Ctrl+Q 里点「打开文件」按钮、文件是网页时，不开浏览器，
// 在按钮那列原来的位置弹一块更大的透明玻璃小窗口，把那个网页装进去。
// 网页本体在 E 盘（说明页 + 用户自己改的内容文件），这里只管窗口：透明、无边框、背后那块屏幕截图发给网页当玻璃底。
// 网页里有 window.guideHost 就知道自己在小窗口里（preload 给的）：onBackground 收截图、close 关窗口。
// 每次打开都重新加载网页，用户改了内容文件下次打开就是新的；开着时 F5 / Ctrl+R 也重新加载。点窗口外面（失焦）就收。

import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { createLogger } from "../shared/log";
import type { Rect } from "./layout";

const log = createLogger("quickcmd");

let sheet: BrowserWindow | null = null;
let background = "";
let wired = false;

/** 弹出说明面板：bounds 是 Electron 坐标，background 是窗口身后那块屏幕（data: 网址，截不到给空串）。 */
export function openSheet(htmlPath: string, bounds: Rect, backgroundUrl: string): void {
  try {
    wireIpc();
    background = backgroundUrl;
    const win = ensureSheet();
    win.hide();
    win.setBounds(bounds);
    void win.loadFile(htmlPath).catch((error) => log.出事(`说明面板打不开 ${htmlPath}`, error, "sheet"));
  } catch (error) {
    log.出事("说明面板弹出失败", error, "sheet");
  }
}

export function closeSheet(): void {
  try {
    sheet?.destroy();
    sheet = null;
  } catch (error) {
    log.出事("说明面板退出清理失败", error, "sheet");
  }
}

function wireIpc(): void {
  if (wired) return;
  wired = true;
  ipcMain.on("guide:close", (event) => {
    if (sheet && !sheet.isDestroyed() && event.sender === sheet.webContents) sheet.hide();
  });
}

function ensureSheet(): BrowserWindow {
  if (sheet && !sheet.isDestroyed()) return sheet;
  const win = new BrowserWindow({
    show: false,
    frame: false,
    // 透明窗口：玻璃是网页自己画的（截图 + 折光 + 模糊），圆角外真透明。
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "sheet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("guide:background", background);
    if (!win.isVisible()) {
      win.show();
      win.setAlwaysOnTop(true, "pop-up-menu");
      win.focus();
    }
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
      event.preventDefault();
      win.webContents.reload();
    }
  });
  // 只许看这个网页：不跳走、不开新窗口。
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("blur", () => {
    if (!win.isDestroyed()) win.hide();
  });
  win.on("closed", () => {
    if (sheet === win) sheet = null;
  });
  win.webContents.on("render-process-gone", (_event, details) => log.出事(`说明面板渲染进程挂了：${details.reason}`, undefined, "sheet"));
  sheet = win;
  return win;
}
