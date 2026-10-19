import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("geminiQuota", { get: () => ipcRenderer.invoke("gemini-quota:get") });
