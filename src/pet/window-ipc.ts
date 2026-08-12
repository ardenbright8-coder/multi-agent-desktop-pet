// 渲染层对窗口本身的请求（拖动、悬停命中、面板展开、隐藏）在这儿落地。
// 跟事件中心那几个 hub:* 请求分开：那些是 channel 的活，这些只动窗口。

import { ipcMain } from "electron";
import {
  hideMainWindow,
  setHoveringInteractive,
  setPanelVisibility,
  startDragging,
  stopDragging,
} from "./window";

export function registerWindowIpc(): void {
  // 界面只报「按下了、松开了」和按下时鼠标在窗口里的偏移，坐标一律由主进程自己读系统光标。
  // 界面给的 screenX/screenY 是物理像素，跟 setPosition 要的 DIP 差一个缩放倍数（见 window.ts）。
  ipcMain.on("window:drag-start", (_event, offset: { x?: unknown; y?: unknown }) => {
    startDragging({ x: Number(offset?.x), y: Number(offset?.y) });
  });
  ipcMain.on("window:drag-stop", () => stopDragging());
  ipcMain.on("window:hover-interactive", (_event, hovering: boolean) => setHoveringInteractive(Boolean(hovering)));
  ipcMain.on("window:panel-visibility", (_event, visible: boolean) => setPanelVisibility(Boolean(visible)));
  ipcMain.on("window:hide", () => hideMainWindow());
}
