// 渲染层跟事件中心之间的请求（快照、搜索、诊断、交回答案、发模拟事件）。
// 只跟 hub 打交道，不碰窗口——窗口那几个请求在 pet\window-ipc.ts。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboard, ipcMain } from "electron";
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
  ipcMain.on("hub:interaction-hold", (_event, eventId: unknown) => hub.holdInteraction(eventId));
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
const PANEL_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

export function panelImageDirectory(): string {
  return PANEL_IMAGE_DIR;
}

function sniffImageExt(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return undefined;
}

function readClipboardImage(): { bytes: Buffer; ext: string } | null {
  try {
    if (clipboard && typeof clipboard.readImage === "function") {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        if (png.length > 0 && png.length <= PANEL_IMAGE_MAX_BYTES) {
          return { bytes: png, ext: "png" };
        }
      }
    }
    if (clipboard && typeof clipboard.readBuffer === "function") {
      const raw = clipboard.readBuffer("FileNameW");
      if (raw && raw.length >= 4) {
        const filePath = raw.toString("utf16le").split("\0")[0]?.trim() || "";
        if (filePath && existsSync(filePath)) {
          const stat = statSync(filePath);
          if (stat.isFile() && stat.size > 0 && stat.size <= PANEL_IMAGE_MAX_BYTES) {
            const bytes = readFileSync(filePath);
            const ext = sniffImageExt(bytes);
            if (ext) return { bytes, ext };
          }
        }
      }
    }
  } catch { /* 剪贴板读不出就放弃 */ }
  return null;
}

export function savePanelImage(dataUrl: unknown, now = new Date()): string | null {
  if (typeof dataUrl !== "string") return null;
  let bytes: Buffer;
  let ext: string | undefined;
  if (dataUrl === "clipboard") {
    const clip = readClipboardImage();
    if (!clip) return null;
    bytes = clip.bytes;
    ext = clip.ext;
  } else {
    const match = /^data:([a-z0-9/+.-]*);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match) return null;
    const mime = (match[1] || "").toLowerCase();
    bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > PANEL_IMAGE_MAX_BYTES) return null;
    ext = PANEL_IMAGE_TYPES[mime];
    if (!ext && (mime === "" || mime === "application/octet-stream")) {
      ext = sniffImageExt(bytes);
    }
    if (!ext) return null;
  }
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
