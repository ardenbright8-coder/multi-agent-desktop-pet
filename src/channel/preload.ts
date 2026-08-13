import { contextBridge, ipcRenderer } from "electron";
import type { DiagnosticsSnapshot, HubSnapshot, InteractionResponseInput, InteractionSubmitResult, SearchHit, SearchQuery } from "../shared/protocol";

contextBridge.exposeInMainWorld("agentPet", {
  snapshot: (): Promise<HubSnapshot> => ipcRenderer.invoke("hub:snapshot"),
  search: (query: SearchQuery): Promise<SearchHit[]> => ipcRenderer.invoke("hub:search", query),
  diagnostics: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke("hub:diagnostics"),
  simulate: (kind?: string): Promise<HubSnapshot> => ipcRenderer.invoke("hub:simulate", kind),
  respondInteraction: (response: InteractionResponseInput): Promise<InteractionSubmitResult> => ipcRenderer.invoke("hub:interaction-respond", response),
  startDragging: (offset: { x: number; y: number }): void => ipcRenderer.send("window:drag-start", offset),
  stopDragging: (): void => ipcRenderer.send("window:drag-stop"),
  setHoveringInteractive: (hovering: boolean): void => ipcRenderer.send("window:hover-interactive", hovering),
  setPanelVisibility: (visible: boolean): void => ipcRenderer.send("window:panel-visibility", visible),
  focusAgent: (hint?: { agent?: string; project?: string; originPid?: number }): void => ipcRenderer.send("window:focus-agent", hint || {}),
  hideWindow: (): void => ipcRenderer.send("window:hide"),
  reportError: (info: { message: string; where?: string; stack?: string }): void => ipcRenderer.send("window:renderer-error", info),
  onNoteSide: (listener: (side: "left" | "right") => void): void => {
    ipcRenderer.on("pet:note-side", (_event, side: "left" | "right") => listener(side));
  },
  onPetCommand: (listener: (command: string) => void): void => {
    ipcRenderer.on("pet:command", (_event, command: string) => listener(command));
  },
  onSnapshot: (listener: (snapshot: HubSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: HubSnapshot) => listener(snapshot);
    ipcRenderer.on("hub:snapshot", handler);
    return () => ipcRenderer.off("hub:snapshot", handler);
  },
});
