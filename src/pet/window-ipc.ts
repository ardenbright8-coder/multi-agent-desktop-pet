// 渲染层对窗口本身的请求（拖动、悬停命中、面板展开、隐藏）在这儿落地。
// 跟事件中心那几个 hub:* 请求分开：那些是 channel 的活，这些只动窗口。

import { ipcMain, shell, app } from "electron";
import { createLogger } from "../shared/log";
import {
  hideMainWindow,
  setHoveringInteractive,
  setPanelVisibility,
  showMainWindow,
  startDragging,
  stopDragging,
  setShuttingDown,
} from "./window";
import { focusAgentWindow } from "./focus-agent";
import { logRoot } from "../shared/log";

const log = createLogger("window");

export function registerWindowIpc(): void {
  // 界面只报「按下了、松开了」和按下时鼠标在窗口里的偏移，坐标一律由主进程自己读系统光标。
  // 界面给的 screenX/screenY 是物理像素，跟 setPosition 要的 DIP 差一个缩放倍数（见 window.ts）。
  ipcMain.on("window:drag-start", (_event, offset: Record<string, unknown>) => {
    startDragging({ x: Number(offset?.x), y: Number(offset?.y) }, offset);
  });
  ipcMain.on("window:drag-stop", () => stopDragging());
  ipcMain.on("window:hover-interactive", (_event, hovering: boolean) => setHoveringInteractive(Boolean(hovering)));
  ipcMain.on("window:panel-visibility", (_event, visible: boolean) => setPanelVisibility(Boolean(visible)));
  ipcMain.on("window:focus-agent", (_event, hint: { agent?: unknown; project?: unknown; originPid?: unknown }) => {
    focusAgentWindow({
      agent: String(hint?.agent || ""),
      project: String(hint?.project || ""),
      originPid: Number(hint?.originPid) || undefined,
    });
  });
  ipcMain.on("window:hide", () => hideMainWindow());
  // 2026-08-14：托盘功能集成到窗口右键菜单，新增 show / open-logs / quit
  ipcMain.on("window:show", () => showMainWindow());
  ipcMain.on("window:open-logs", () => { void shell.openPath(logRoot()); });
  ipcMain.on("window:quit", () => { setShuttingDown(true); app.quit(); });
  // 界面里出的错以前谁也看不见，现在一律落到 window 那本日志里
  ipcMain.on("window:renderer-error", (_event, info: { message?: unknown; where?: unknown; stack?: unknown }) => {
    log.出事(`界面出错：${String(info?.message ?? "未知")}`, info?.stack ? String(info.stack) : undefined, String(info?.where ?? "renderer"));
  });
}
