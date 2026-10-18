// 板块与内存（2026-10-18 用户拍板）：右键「板块与内存」弹一个小窗口，列出程序里装了几个板块、各自在不在跑，
// 整个程序占多少内存、绿黄红、离警戒线还能加多少。到黄线了他就知道该把新功能另开一个自启程序。
//
// 🚨 隔离铁律：只认 shared。各板块的状态由 app.ts 用 initOverview(getBlocks) 注入，这块不 import 任何板块。
// 对外只露出 initOverview / openOverview / closeOverview。
// 窗口平时不开（开着就多一个进程、多占几十兆），点了才建，关了就销毁。

import { join } from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import { createLogger } from "../shared/log";
import { summarize, type MemorySummary, type ProcessSample } from "./metrics";

const log = createLogger("overview");

export interface BlockInfo {
  name: string;
  what: string;
  state: "在跑" | "没启用" | "出错";
  /** 一句补充，比如「今天补了 3 张」。 */
  detail?: string;
}

export interface OverviewSnapshot {
  blocks: BlockInfo[];
  memory: MemorySummary;
  at: number;
}

let getBlocks: () => BlockInfo[] = () => [];
let win: BrowserWindow | null = null;

export function initOverview(provider: () => BlockInfo[]): void {
  getBlocks = provider;
  try {
    ipcMain.handle("overview:get", () => snapshot());
  } catch (error) {
    log.出事("板块总览初始化失败（不影响别的板块）", error, "init");
  }
}

export function openOverview(): void {
  try {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 480,
      height: 620,
      title: "板块与内存",
      icon: join(__dirname, "..", "assets", "app-icon.png"),
      autoHideMenuBar: true,
      resizable: true,
      minimizable: true,
      maximizable: false,
      backgroundColor: "#eef7f1",
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenu(null);
    win.on("closed", () => { win = null; });
    void win.loadFile(join(__dirname, "renderer", "index.html"));
  } catch (error) {
    log.出事("打开板块总览失败", error, "open");
  }
}

export function closeOverview(): void {
  try {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  } catch {
    // 退出时关不掉也无所谓
  }
}

function snapshot(): OverviewSnapshot {
  const titles = new Map<number, string[]>();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const pid = window.webContents.getOSProcessId();
    titles.set(pid, [...(titles.get(pid) || []), window.getTitle()]);
  }
  const self = win && !win.isDestroyed() ? [win.webContents.getOSProcessId()] : [];
  const samples: ProcessSample[] = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    serviceName: metric.serviceName,
    privateKB: metric.memory.privateBytes ?? metric.memory.workingSetSize,
    windowTitles: titles.get(metric.pid) || [],
  }));
  let blocks: BlockInfo[] = [];
  try {
    blocks = getBlocks();
  } catch (error) {
    log.出事("问各板块状态出错", error, "snapshot");
  }
  return { blocks, memory: summarize(samples, self), at: Date.now() };
}
