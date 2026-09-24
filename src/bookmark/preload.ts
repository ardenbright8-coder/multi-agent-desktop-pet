// 书签台渲染层的专属桥。跟桌宠的 channel\preload 互不相干（完全隔离）。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bookmark", {
  saveImage: (bytes: Uint8Array) => ipcRenderer.invoke("bookmark:image:save", bytes) as Promise<string>,
  readImage: (name: string) => ipcRenderer.invoke("bookmark:image:read", name) as Promise<string>,
  list: () => ipcRenderer.invoke("bookmark:list"),
  add: (input: unknown) => ipcRenderer.invoke("bookmark:add", input),
  insertBeside: (input: unknown) => ipcRenderer.invoke("bookmark:insert-beside", input),
  move: (id: string, anchorId: string, place: "above" | "below") => ipcRenderer.invoke("bookmark:move", { id, anchorId, place }),
  remove: (id: string) => ipcRenderer.invoke("bookmark:remove", id),
  setAssignee: (id: string, assignee: string | null) => ipcRenderer.invoke("bookmark:set-assignee", { id, assignee }),
  // 输入行自动存档（改版三）：草稿已入库后边写边改同一条。
  updateText: (id: string, text: string, url: string | null) => ipcRenderer.invoke("bookmark:update-text", { id, text, url }),
  templates: () => ipcRenderer.invoke("bookmark:templates") as Promise<string[]>,
  copyForAgent: (id: string, template: string | null) => ipcRenderer.invoke("bookmark:copy-for-agent", { id, template }) as Promise<string>,
  openTemplates: () => ipcRenderer.invoke("bookmark:templates:open"),
  bundle: (id: string, targetId: string) => ipcRenderer.invoke("bookmark:bundle", { id, targetId }),
  unbundle: (bundleId: string) => ipcRenderer.invoke("bookmark:unbundle", bundleId),
  release: (id: string) => ipcRenderer.invoke("bookmark:release", id),
  launchLine: (target: string, group: string, coding: boolean) =>
    ipcRenderer.invoke("bookmark:launch-line", { target, group, coding }) as Promise<{ line: string; label: string; opened: string | null; freshWindow: boolean; problem: string | null }>,
  agents: () => ipcRenderer.invoke("bookmark:agents"),
  moveAgent: (name: string, anchor: string, place: "above" | "below") => ipcRenderer.invoke("bookmark:agents:move", { name, anchor, place }),
  addAgent: (name: string) => ipcRenderer.invoke("bookmark:agents:add", name),
  removeAgent: (name: string) => ipcRenderer.invoke("bookmark:agents:remove", name),
  reload: () => ipcRenderer.invoke("bookmark:reload"),
  codeStatus: () => ipcRenderer.invoke("bookmark:code-status"),
  // 手机消息入库后的推送刷新（主进程收信后发 bookmark:inbox-changed）。
  onInboxChanged: (callback: () => void) => {
    ipcRenderer.on("bookmark:inbox-changed", () => callback());
  },
  // 外观设置（透明度滑条）：读用在首渲染前，写由滑条防抖调。
  getAppearance: () => ipcRenderer.invoke("bookmark:appearance:get") as Promise<number>,
  setAppearance: (opacity: number) => ipcRenderer.invoke("bookmark:appearance:set", opacity) as Promise<number>,
  // 📁 项目文件夹（第三页签）：真实文件夹+真实 md，存 bookmark\projects\；open 交系统默认程序。
  projectsList: (relative: string) => ipcRenderer.invoke("bookmark:projects:list", relative),
  projectsMkdir: (parent: string, name: string) => ipcRenderer.invoke("bookmark:projects:mkdir", { parent, name }),
  projectsTouch: (parent: string, name: string) => ipcRenderer.invoke("bookmark:projects:touch", { parent, name }),
  projectsReorder: (parent: string, moving: string, anchor: string, place: "above" | "below") =>
    ipcRenderer.invoke("bookmark:projects:reorder", { parent, moving, anchor, place }),
  projectsOpen: (relative: string) => ipcRenderer.invoke("bookmark:projects:open", relative),
});
