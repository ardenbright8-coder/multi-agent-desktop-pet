// 书签台渲染层的专属桥。跟桌宠的 channel\preload 互不相干（完全隔离）。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bookmark", {
  list: () => ipcRenderer.invoke("bookmark:list"),
  add: (input: unknown) => ipcRenderer.invoke("bookmark:add", input),
  remove: (id: string) => ipcRenderer.invoke("bookmark:remove", id),
  setAssignee: (id: string, assignee: string | null) => ipcRenderer.invoke("bookmark:set-assignee", { id, assignee }),
  hide: () => ipcRenderer.invoke("bookmark:hide"),
});
