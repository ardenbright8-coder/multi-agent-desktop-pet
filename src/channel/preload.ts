import { contextBridge, ipcRenderer } from "electron";
import type { DiagnosticsSnapshot, HubSnapshot, InteractionResponseInput, InteractionSubmitResult, SearchHit, SearchQuery } from "../shared/protocol";

contextBridge.exposeInMainWorld("agentPet", {
  snapshot: (): Promise<HubSnapshot> => ipcRenderer.invoke("hub:snapshot"),
  search: (query: SearchQuery): Promise<SearchHit[]> => ipcRenderer.invoke("hub:search", query),
  diagnostics: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke("hub:diagnostics"),
  simulate: (kind?: string): Promise<HubSnapshot> => ipcRenderer.invoke("hub:simulate", kind),
  respondInteraction: (response: InteractionResponseInput): Promise<InteractionSubmitResult> => ipcRenderer.invoke("hub:interaction-respond", response),
  moveWindowToPointer: (position: { screenX: number; screenY: number; anchorX: number; anchorY: number }): void => ipcRenderer.send("window:move-to-pointer", position),
  finishWindowMove: (): void => ipcRenderer.send("window:finish-move"),
  setPetPickedUp: (pickedUp: boolean): void => ipcRenderer.send("window:pickup-state", pickedUp),
  setPanelVisibility: (visible: boolean): void => ipcRenderer.send("window:panel-visibility", visible),
  hideWindow: (): void => ipcRenderer.send("window:hide"),
  onSnapshot: (listener: (snapshot: HubSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: HubSnapshot) => listener(snapshot);
    ipcRenderer.on("hub:snapshot", handler);
    return () => ipcRenderer.off("hub:snapshot", handler);
  },
});
