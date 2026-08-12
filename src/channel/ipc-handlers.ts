// 渲染层跟事件中心之间的请求（快照、搜索、诊断、交回答案、发模拟事件）。
// 只跟 hub 打交道，不碰窗口——窗口那几个请求在 pet\window-ipc.ts。

import { ipcMain } from "electron";
import type { InteractionResponseInput, SearchQuery } from "../shared/protocol";
import type { AgentHub } from "../events/hub";
import { makeSimulationEvent } from "../events/simulation";
import type { EventKind } from "../shared/protocol";

export interface HubIpcOptions {
  // 控件自测要知道用户最后交回了什么。生产环境不传，这块就是纯转发。
  onInteractionResponse?(response: InteractionResponseInput): void;
}

export function registerHubIpc(hub: AgentHub, options: HubIpcOptions = {}): void {
  ipcMain.handle("hub:snapshot", () => hub.snapshot());
  ipcMain.handle("hub:search", (_event, query: SearchQuery) => hub.search(query || {}));
  ipcMain.handle("hub:diagnostics", () => hub.diagnostics());
  ipcMain.handle("hub:interaction-respond", (_event, response: InteractionResponseInput) => {
    options.onInteractionResponse?.(response);
    const result = hub.submitInteractionResponse(response);
    if (response?.agent === "simulator") {
      const claim = hub.claimInteractionResponse({
        eventId: response.eventId,
        agent: response.agent,
        sessionId: response.sessionId,
        providerRequestId: response.providerRequestId,
        sourceInstance: "desktop-simulator",
      });
      if (claim) hub.completeInteractionResponse({ responseId: claim.responseId, claimToken: claim.claimToken, success: true });
    }
    return result;
  });
  ipcMain.handle("hub:simulate", (_event, requestedKind?: string) => {
    const event = makeSimulationEvent(requestedKind as EventKind | undefined);
    hub.publish(event);
    return hub.snapshot();
  });
}
