import { contextBridge, ipcRenderer } from "electron";
import type { DiagnosticsSnapshot, HubSnapshot, SearchHit, SearchQuery } from "../shared/protocol";

contextBridge.exposeInMainWorld("agentPet", {
  snapshot: (): Promise<HubSnapshot> => ipcRenderer.invoke("hub:snapshot"),
  search: (query: SearchQuery): Promise<SearchHit[]> => ipcRenderer.invoke("hub:search", query),
  diagnostics: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke("hub:diagnostics"),
  simulate: (kind?: string): Promise<HubSnapshot> => ipcRenderer.invoke("hub:simulate", kind),
  setMousePassthrough: (enabled: boolean): void => ipcRenderer.send("window:mouse-passthrough", enabled),
  hideWindow: (): void => ipcRenderer.send("window:hide"),
  onSnapshot: (listener: (snapshot: HubSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: HubSnapshot) => listener(snapshot);
    ipcRenderer.on("hub:snapshot", handler);
    return () => ipcRenderer.off("hub:snapshot", handler);
  },
  onPetMotion: (listener: (direction: "left" | "right") => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, direction: "left" | "right") => listener(direction);
    ipcRenderer.on("window:pet-motion", handler);
    return () => ipcRenderer.off("window:pet-motion", handler);
  },
});
