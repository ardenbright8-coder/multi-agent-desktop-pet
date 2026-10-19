// 仅暴露本小样的白名单消息；不读文件、账号或桌宠接口。
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("glassPreview", Object.freeze({
  get: () => ipcRenderer.invoke("glass-preview:get"),
  hover: value => ipcRenderer.send("glass-preview:hover", value === true),
  action: action => ipcRenderer.send("glass-preview:action", action),
  count: count => ipcRenderer.send("glass-preview:count", count),
  drag: phase => ipcRenderer.send("glass-preview:drag", phase),
  onSnapshot: callback => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("glass-preview:snapshot", handler);
    return () => ipcRenderer.removeListener("glass-preview:snapshot", handler);
  }
}));
