// 说明面板的桥：网页看见 window.guideHost 就知道自己在桌宠小窗口里。只给两样：收背后截图、关窗口。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("guideHost", {
  onBackground: (callback: (url: string) => void) => {
    ipcRenderer.on("guide:background", (_event, url) => callback(typeof url === "string" ? url : ""));
  },
  close: () => ipcRenderer.send("guide:close"),
});
