import { contextBridge, ipcRenderer } from "electron";
import type { DiagnosticsSnapshot, HubSnapshot, InteractionResponseInput, InteractionSubmitResult, SearchHit, SearchQuery } from "../shared/protocol";

contextBridge.exposeInMainWorld("agentPet", {
  snapshot: (): Promise<HubSnapshot> => ipcRenderer.invoke("hub:snapshot"),
  search: (query: SearchQuery): Promise<SearchHit[]> => ipcRenderer.invoke("hub:search", query),
  diagnostics: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke("hub:diagnostics"),
  simulate: (kind?: string): Promise<HubSnapshot> => ipcRenderer.invoke("hub:simulate", kind),
  respondInteraction: (response: InteractionResponseInput): Promise<InteractionSubmitResult> => ipcRenderer.invoke("hub:interaction-respond", response),
  // 面板输入框粘进来的图：存进 24 小时临时夹，回文件位置（存不了回 null）
  savePanelImage: (dataUrl: string): Promise<string | null> => ipcRenderer.invoke("hub:save-panel-image", dataUrl),
  // 他正在用权限/询问窗：报一声「别倒计时」
  holdInteraction: (eventId: string): void => ipcRenderer.send("hub:interaction-hold", eventId),
  startDragging: (offset: { x: number; y: number }): void => ipcRenderer.send("window:drag-start", offset),
  stopDragging: (): void => ipcRenderer.send("window:drag-stop"),
  setHoveringInteractive: (hovering: boolean): void => ipcRenderer.send("window:hover-interactive", hovering),
  setPanelVisibility: (visible: boolean, height?: number, needsAction?: boolean): void => ipcRenderer.send("window:panel-visibility", visible, height, needsAction),
  focusAgent: (hint?: { agent?: string; project?: string; originPid?: number }): void => ipcRenderer.send("window:focus-agent", hint || {}),
  hideWindow: (): void => ipcRenderer.send("window:hide"),
  // 2026-08-14：托盘功能集成到窗口右键菜单
  showWindow: (): void => ipcRenderer.send("window:show"),
  openLogs: (): void => ipcRenderer.send("window:open-logs"),
  quitApp: (): void => ipcRenderer.send("window:quit"),
  openOverview: (): void => ipcRenderer.send("window:open-overview"),
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
