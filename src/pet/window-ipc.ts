// 渲染层对窗口本身的请求（拖动、拿起、面板展开、隐藏）在这儿落地。
// 跟事件中心那几个 hub:* 请求分开：那些是 channel 的活，这些只动窗口。

import { ipcMain } from "electron";
import {
  hideMainWindow,
  keepWindowOnVisibleDisplay,
  moveWindowToPointer,
  setPanelVisibility,
  setPetPickedUp,
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
  ipcMain.on("window:pickup-state", (_event, pickedUp: boolean) => setPetPickedUp(Boolean(pickedUp)));
  ipcMain.on("window:panel-visibility", (_event, visible: boolean) => setPanelVisibility(Boolean(visible)));
  ipcMain.on("window:hide", () => hideMainWindow());
}
