// 渲染层跟事件中心之间的请求（快照、搜索、诊断、交回答案、发模拟事件）。
// 只跟 hub 打交道，不碰窗口——窗口那几个请求在 pet\window-ipc.ts。

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ipcMain.handle("hub:save-panel-image", (_event, dataUrl: unknown) => savePanelImage(dataUrl));
  ipcMain.handle("hub:simulate", (_event, requestedKind?: string) => {
    const event = makeSimulationEvent(requestedKind as EventKind | undefined);
    hub.publish(event);
    return hub.snapshot();
  });
}

// ═══ 面板附言里的图片（2026-11-04 他要的）═══
// 他在桌宠输入框 Ctrl+V 粘截图，AI 要有个文件才打得开看。图是临时用的：放系统临时夹，
// 超过 24 小时自己删，不进数据夹、不攒垃圾（他原话：「这种东西都是垃圾，临时用的」）。
// 夹名别用 bm- / agent-pet- 开头：那两个前缀是测试临时夹，编译时会被清掉。
const PANEL_IMAGE_DIR = join(tmpdir(), "桌宠附图");
const PANEL_IMAGE_KEEP_MS = 24 * 60 * 60 * 1000;
const PANEL_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const PANEL_IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };

export function panelImageDirectory(): string {
  return PANEL_IMAGE_DIR;
}

export function savePanelImage(dataUrl: unknown, now = new Date()): string | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const ext = match ? PANEL_IMAGE_TYPES[match[1]] : undefined;
  if (!match || !ext) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > PANEL_IMAGE_MAX_BYTES) return null;
  mkdirSync(PANEL_IMAGE_DIR, { recursive: true });
  sweepPanelImages(now.getTime());
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const file = join(PANEL_IMAGE_DIR, `附图_${stamp}_${Math.random().toString(36).slice(2, 6)}.${ext}`);
  writeFileSync(file, bytes);
  return file;
}

function sweepPanelImages(nowMs: number): void {
  try {
    for (const name of readdirSync(PANEL_IMAGE_DIR)) {
      const file = join(PANEL_IMAGE_DIR, name);
      try {
        if (nowMs - statSync(file).mtimeMs > PANEL_IMAGE_KEEP_MS) unlinkSync(file);
      } catch { /* 删不掉下回再删 */ }
    }
  } catch { /* 夹还没有 */ }
}
