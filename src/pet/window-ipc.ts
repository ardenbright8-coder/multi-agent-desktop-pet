// 渲染层对窗口本身的请求（拖动、悬停命中、面板展开、隐藏）在这儿落地。
// 跟事件中心那几个 hub:* 请求分开：那些是 channel 的活，这些只动窗口。

import { ipcMain } from "electron";
import {
  hideMainWindow,
  keepWindowOnVisibleDisplay,
  moveWindowToPointer,
  setDragging,
  setHoveringInteractive,
  setPanelVisibility,
} from "./window";

export function registerWindowIpc(): void {
  ipcMain.on("window:move-to-pointer", (_event, position: { screenX?: unknown; screenY?: unknown; anchorX?: unknown; anchorY?: unknown }) => {
    const values = [position?.screenX, position?.screenY, position?.anchorX, position?.anchorY];
    if (!values.every(Number.isFinite)) return;
    const x = Math.round(Number(position.screenX) - Number(position.anchorX));
    const y = Math.round(Number(position.screenY) - Number(position.anchorY));
    moveWindowToPointer(x, y);
  });
  ipcMain.on("window:finish-move", () => keepWindowOnVisibleDisplay());
  ipcMain.on("window:drag-state", (_event, dragging: boolean) => setDragging(Boolean(dragging)));
  ipcMain.on("window:hover-interactive", (_event, hovering: boolean) => setHoveringInteractive(Boolean(hovering)));
  ipcMain.on("window:panel-visibility", (_event, visible: boolean) => setPanelVisibility(Boolean(visible)));
  ipcMain.on("window:hide", () => hideMainWindow());
}
