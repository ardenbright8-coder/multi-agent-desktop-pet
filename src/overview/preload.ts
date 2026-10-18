// 板块与内存窗口的界面桥。跟桌宠、看板、Ctrl+Q 的 preload 互不相干。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("overview", {
  get: () => ipcRenderer.invoke("overview:get"),
});
