// 界面只可调本小样的白名单消息；不暴露文件、登录信息和其他板块。
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("glassPreview", Object.freeze({
  get: () => ipcRenderer.invoke("glass-preview:get"),
  hover: (value, reducedMotion) => ipcRenderer.send("glass-preview:hover", value === true, reducedMotion === true),
  action: action => ipcRenderer.send("glass-preview:action", action),
  count: count => ipcRenderer.send("glass-preview:count", count),
  select: index => ipcRenderer.send("glass-preview:select", index),
  cycle: direction => ipcRenderer.send("glass-preview:cycle", direction),
  drag: phase => ipcRenderer.send("glass-preview:drag", phase),
  onSnapshot: callback => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("glass-preview:snapshot", handler);
    return () => ipcRenderer.removeListener("glass-preview:snapshot", handler);
  }
}));
