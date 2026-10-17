// Agent命令快捷窗口的界面桥。跟桌宠、看板的 preload 互不相干。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("quickcmd", {
  // 每次弹出：按钮上的字 + 窗口身后那块屏幕的截图（data: 网址，截不到是空串）。
  onButtons: (callback: (payload: { labels: string[]; background: string }) => void) => {
    ipcRenderer.on("quickcmd:buttons", (_event, payload) => {
      const labels = Array.isArray(payload?.labels) ? payload.labels.map(String) : [];
      const background = typeof payload?.background === "string" ? payload.background : "";
      callback({ labels, background });
    });
  },
  press: (index: number) => ipcRenderer.send("quickcmd:press", index),
  // 拖按钮换位置：第 from 个跟第 to 个交换。
  swap: (from: number, to: number) => ipcRenderer.send("quickcmd:swap", from, to),
});
