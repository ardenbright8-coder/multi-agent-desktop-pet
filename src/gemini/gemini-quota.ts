// Gemini 独立板块。只给桌宠加一条装配，不修改 Agent 事件、看板或登录状态。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import { appDataRoot, isIsolatedRun } from "../shared/paths";
import { createLogger } from "../shared/log";
import { QuotaStore } from "./model";
import { startQuotaReceiver, type QuotaReceiver } from "./receiver";

const log = createLogger("app");
let store: QuotaStore | null = null;
let receiver: QuotaReceiver | null = null;
let win: BrowserWindow | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let anchor: () => Rectangle | undefined = () => undefined;
let hidden = false, failure = "", previous = "", shuttingDown = false, allowShow = true, backgroundOnly = false;
let orbChild: ReturnType<typeof spawn> | null = null;

function ensureGlassOrbStarted(): void {
  if (isIsolatedRun() || process.env.AGENT_GEMINI_HEADLESS_TEST === "1" || process.env.GEMINI_GLASS_PREVIEW_TEST === "1") return;
  try {
    const orbEntry = resolve(__dirname, "..", "..", "src", "gemini", "_玻璃圆环小样（独立贴边·演示数据）", "main.cjs");
    if (!existsSync(orbEntry)) return;
    if (orbChild && !orbChild.killed) {
      try { orbChild.kill(); } catch { /* ignore */ }
      orbChild = null;
    }
    const child = spawn(process.execPath, [orbEntry], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    orbChild = child;
  } catch { /* 小球独立进程失败不影响桌宠本体 */ }
}

export async function initGeminiQuota(options: { root?: string; anchor?: () => Rectangle | undefined; display?: boolean; backgroundOnly?: boolean } = {}): Promise<void> {
  if (receiver) return;
  shuttingDown = false; failure = ""; hidden = false; allowShow = options.display !== false; backgroundOnly = options.backgroundOnly === true;
  anchor = options.anchor || (() => undefined);
  const root = options.root || join(appDataRoot(), "gemini");
  store = new QuotaStore(join(root, "readings.json"));
  try {
    receiver = await startQuotaReceiver(root, store, readFileSync(join(__dirname, "collector.user.js"), "utf8"), syncWindow);
    ipcMain.handle("gemini-quota:get", event => {
      if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) throw new Error("Wrong quota renderer");
      return { accounts: store?.snapshot() || [] };
    });
    timer = setInterval(syncWindow, 2000); timer.unref();
    if (backgroundOnly && allowShow) ensureGlassOrbStarted();
    log.记("Gemini只读收件器已启动（不记录凭据、账号邮箱或聊天内容）", "gemini");
  } catch (error) {
    failure = error instanceof Error ? error.message : "初始化失败";
    await receiver?.close(); receiver = null;
    log.出事("Gemini用量板块未启动，不影响其他板块", error, "gemini");
  }
}
export function geminiQuotaStatus(): { state: "在跑" | "没启用" | "出错"; detail: string } {
  return { state: failure ? "出错" : receiver ? "在跑" : "没启用", detail: failure ? "收件器未启动，未连接其他服务" : receiver ? `已接入${store?.snapshot().length || 0}个账号；只读监控` : "尚未启动" };
}
export function toggleGeminiQuota(): void {
  hidden = !hidden; syncWindow();
}
export async function closeGeminiQuota(): Promise<void> {
  shuttingDown = true;
  if (timer) clearInterval(timer); timer = null;
  if (orbChild && !orbChild.killed) {
    try { orbChild.kill(); } catch { /* ignore */ }
    orbChild = null;
  }
  ipcMain.removeHandler("gemini-quota:get");
  win?.destroy(); win = null; previous = "";
  const old = receiver; receiver = null; await old?.close(); store = null;
}
function syncWindow(): void {
  if (shuttingDown) { if (win && !win.isDestroyed()) win.destroy(); return; }
  const rows = store?.snapshot() || [];
  if (backgroundOnly) { if (win && !win.isDestroyed()) win.destroy(); return; }
  if (hidden || !rows.length) { win?.destroy(); return; }
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({ width: 116, height: 48, title: "Gemini用量提示球", frame: false, transparent: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      focusable: false, show: false, hasShadow: false,
      webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.setMenu(null); win.setAlwaysOnTop(true, "screen-saver");
    // 整窗只作显示，透明部分和提示球本身都不拦用户鼠标。控制入口在托盘。
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.once("did-finish-load", syncWindow);
    win.on("closed", () => { win = null; previous = ""; });
    void win.loadFile(join(__dirname, "renderer", "index.html"));
  }
  const origin = anchor(); const area = origin ? screen.getDisplayMatching(origin).workArea : screen.getPrimaryDisplay().workArea;
  const width = 116, height = Math.min(rows.length, 8) * 49 - 1;
  let x = origin?.x ?? area.x + area.width - width - 12;
  let y = origin ? origin.y + origin.height + 6 : area.y + 18;
  if (y + height > area.y + area.height - 8 && origin) y = origin.y - height - 6;
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - width - 4));
  y = Math.max(area.y + 4, Math.min(y, area.y + area.height - height - 4));
  const bounds = { x, y, width, height }; const fingerprint = JSON.stringify(bounds);
  if (fingerprint !== previous) { previous = fingerprint; win.setBounds(bounds, false); }
  if (allowShow && !win.webContents.isLoadingMainFrame() && !win.isVisible()) win.showInactive();
}
