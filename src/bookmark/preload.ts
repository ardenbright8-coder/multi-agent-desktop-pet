// 书签台渲染层的专属桥。跟桌宠的 channel\preload 互不相干（完全隔离）。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bookmark", {
  list: () => ipcRenderer.invoke("bookmark:list"),
  add: (input: unknown) => ipcRenderer.invoke("bookmark:add", input),
  remove: (id: string) => ipcRenderer.invoke("bookmark:remove", id),
  setAssignee: (id: string, assignee: string | null) => ipcRenderer.invoke("bookmark:set-assignee", { id, assignee }),
  agents: () => ipcRenderer.invoke("bookmark:agents"),
  addAgent: (name: string) => ipcRenderer.invoke("bookmark:agents:add", name),
  removeAgent: (name: string) => ipcRenderer.invoke("bookmark:agents:remove", name),
  hide: () => ipcRenderer.invoke("bookmark:hide"),
  reload: () => ipcRenderer.invoke("bookmark:reload"),
  // 手机消息入库后的推送刷新（主进程收信后发 bookmark:inbox-changed）。
  onInboxChanged: (callback: () => void) => {
    ipcRenderer.on("bookmark:inbox-changed", () => callback());
  },
  // 外观设置（透明度滑条）：读用在首渲染前，写由滑条防抖调。
  getAppearance: () => ipcRenderer.invoke("bookmark:appearance:get") as Promise<number>,
  setAppearance: (opacity: number) => ipcRenderer.invoke("bookmark:appearance:set", opacity) as Promise<number>,
});
