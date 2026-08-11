// multi-agent-desktop-pet managed Pi extension v1
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const APP_ID = "multi-agent-desktop-pet";
const PROTOCOL_VERSION = 1;
const sourceInstance = `pi:${process.pid}:${randomBytes(6).toString("hex")}`;
const sequenceBySession = new Map<string, number>();

const OptionSchema = Type.Object({
  label: Type.String({ description: "Exact option label shown to the user" }),
  description: Type.Optional(Type.String({ description: "Practical difference or consequence of this option" })),
  recommended: Type.Optional(Type.Boolean({ description: "Whether Pi recommends this option" })),
});

const QuestionParams = Type.Object({
  title: Type.String({ description: "Direct title describing the decision" }),
  question: Type.String({ description: "The exact question to ask" }),
  situation: Type.String({ description: "Current situation and true cause" }),
  options: Type.Array(OptionSchema, { description: "Real ordered choices available to Pi" }),
  recommendation: Type.Optional(Type.String({ description: "Recommended choice and why" })),
  impact: Type.Optional(Type.String({ description: "What changes depending on the answer" })),
  allowCustomInput: Type.Optional(Type.Boolean({ description: "Allow the user to type a custom answer" })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 30, maximum: 900 })),
});

const PermissionParams = Type.Object({
  title: Type.String({ description: "Direct title for the permission decision" }),
  situation: Type.String({ description: "What Pi is doing now" }),
  reason: Type.String({ description: "Why this permission is needed now" }),
  action: Type.String({ description: "Exact action covered by this gate" }),
  resources: Type.Array(Type.String(), { description: "Exact files, commands, services, or other resources covered" }),
  impact: Type.Optional(Type.String({ description: "Possible negative effects" })),
  rollback: Type.Optional(Type.String({ description: "How the action can be rolled back, or that this is unknown" })),
  unknowns: Type.Optional(Type.String({ description: "Anything not yet verified" })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 30, maximum: 900 })),
});

export default function agentPetPiExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (event: any, ctx: any) => report(ctx, "session.started", { summary: `Pi 会话已经开始（${event.reason || "startup"}）` }));
  pi.on("before_agent_start", async (event: any, ctx: any) => report(ctx, "state.thinking", { summary: "Pi 正在理解任务", prompt: event.prompt }));
  pi.on("tool_execution_start", async (event: any, ctx: any) => report(ctx, "state.working", {
    summary: `正在使用 ${event.toolName || "工具"}`,
    tool_name: event.toolName,
    tool_input: event.args,
    tool_use_id: event.toolCallId,
  }));
  pi.on("tool_execution_end", async (event: any, ctx: any) => report(ctx, event.isError ? "task.failed" : "state.working", {
    summary: event.isError ? `${event.toolName || "工具"}执行失败` : `已完成 ${event.toolName || "工具"}，继续处理任务`,
    reason: event.isError ? "Pi 工具执行失败" : undefined,
    tool_name: event.toolName,
    tool_input: event.args,
    tool_use_id: event.toolCallId,
  }));
  pi.on("agent_settled", async (_event: any, ctx: any) => report(ctx, "task.completed", { summary: "Pi 已经完成这一轮任务" }));
  pi.on("session_shutdown", async (event: any, ctx: any) => report(ctx, "session.ended", { summary: `Pi 会话已经结束（${event.reason || "quit"}）` }));

  pi.registerTool({
    name: "desktop_pet_question",
    label: "Desktop Pet Question",
    description: "Ask a bounded, structured question through the desktop pet and wait for the user's answer.",
    promptSnippet: "Ask the user a structured question through the desktop pet.",
    promptGuidelines: [
      "Use desktop_pet_question whenever you need the user to choose between real options or provide missing information; do not replace it with a long plain-text question.",
    ],
    parameters: QuestionParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.options.length && params.allowCustomInput === false) return textResult("Desktop pet question has no supported answer options.");
      const sessionId = piSessionId(ctx);
      const requestId = randomUUID();
      const prompts = [{
        id: "question-1",
        question: params.question,
        options: params.options.map((option: { label: string; description?: string; recommended?: boolean }, index: number) => ({
          id: `option-${index + 1}`,
          label: option.label,
          value: option.label,
          description: option.description,
          recommended: option.recommended === true,
        })),
        multiple: false,
        allowCustomInput: params.allowCustomInput !== false,
      }];
      const event = makeInteractionEvent(ctx, sessionId, requestId, "question.asked", {
        title: params.title,
        summary: params.situation,
        reason: params.situation,
        tool: "desktop_pet_question",
        target: params.question,
        interaction: {
          mode: "question",
          title: params.title,
          providerRequestId: requestId,
          prompts,
          recommendation: params.recommendation,
          impact: params.impact,
          responseCapability: true,
          responseStatus: "pending",
        },
      });
      const claim = await publishAndWait(event, params.timeoutSeconds, signal);
      if (!claim) return textResult("Desktop pet did not return an answer before the bounded timeout. Ask in the Pi terminal instead.");
      await completeClaim(claim, true);
      const answer = claim.answers[0];
      const selected = (answer.optionIds || []).map((id: string) => prompts[0].options.find((option: { id: string; label: string }) => option.id === id)?.label).filter(Boolean);
      const value = answer.customText || selected.join(", ");
      return {
        content: [{ type: "text" as const, text: `User answered through the desktop pet: ${value}` }],
        details: { answer: value, wasCustom: Boolean(answer.customText) },
      };
    },
  });

  pi.registerTool({
    name: "desktop_pet_permission",
    label: "Desktop Pet Permission",
    description: "Gate one exact action through the desktop pet. Supports allow-once or reject and always times out.",
    promptSnippet: "Request permission for one exact action through the desktop pet.",
    promptGuidelines: [
      "Before a destructive, privileged, system-changing, or explicitly approval-gated action, call desktop_pet_permission and perform the action only when its result says allowed=true.",
    ],
    parameters: PermissionParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = piSessionId(ctx);
      const requestId = randomUUID();
      const prompts = [{
        id: "permission",
        question: "请选择这次操作是否可以执行",
        options: [
          { id: "once", label: "允许一次", value: "once", description: "只允许当前这次操作" },
          { id: "reject", label: "拒绝", value: "reject", description: "不执行当前操作" },
        ],
        multiple: false,
        allowCustomInput: false,
      }];
      const event = makeInteractionEvent(ctx, sessionId, requestId, "permission.requested", {
        title: params.title,
        summary: params.situation,
        reason: params.reason,
        tool: params.action,
        target: params.resources.join("、"),
        paths: params.resources,
        interaction: {
          mode: "permission",
          title: params.title,
          providerRequestId: requestId,
          prompts,
          action: params.action,
          resources: params.resources,
          impact: params.impact,
          rollback: params.rollback,
          unknowns: params.unknowns,
          responseCapability: true,
          responseStatus: "pending",
        },
      });
      const claim = await publishAndWait(event, params.timeoutSeconds, signal);
      if (!claim) return textResult("Desktop pet permission gate timed out. Do not perform the action; ask in the Pi terminal instead.");
      await completeClaim(claim, true);
      const allowed = claim.answers[0]?.optionIds?.[0] === "once";
      return {
        content: [{ type: "text" as const, text: allowed ? "User allowed this exact action once through the desktop pet." : "User rejected this action through the desktop pet." }],
        details: { allowed, scope: allowed ? "once" : "reject" },
      };
    },
  });
}

function report(ctx: any, kind: string, details: Record<string, unknown>) {
  try {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const bridge = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
    const sessionId = ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.() || "pi-default";
    const payload = {
      ...details,
      session_id: sessionId,
      cwd: ctx?.cwd || process.cwd(),
      title: "Pi 会话",
    };
    const child = spawn(process.execPath, [bridge, "pi", kind], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch {
    // Status reporting must never affect Pi.
  }
}

function makeInteractionEvent(ctx: any, sessionId: string, requestId: string, kind: string, details: Record<string, unknown>) {
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance,
    sequence: nextSequence(sessionId),
    emittedAt: Date.now(),
    agent: "pi",
    sessionId,
    kind,
    project: ctx?.cwd ? String(ctx.cwd).split(/[\\/]/).filter(Boolean).at(-1) : "Pi",
    cwd: ctx?.cwd || process.cwd(),
    requestId,
    ...details,
  };
}

async function publishAndWait(event: any, timeoutSeconds: number | undefined, signal?: AbortSignal) {
  try {
    const published = await sendRequest("event.publish", event);
    if (published?.status !== "accepted" && published?.status !== "duplicate") return null;
  } catch {
    return null;
  }
  const deadline = Date.now() + Math.max(30, Math.min(900, timeoutSeconds || 600)) * 1000;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const claim = await sendRequest("interaction.response.claim", {
        eventId: event.eventId,
        agent: event.agent,
        sessionId: event.sessionId,
        providerRequestId: event.requestId,
        sourceInstance,
      });
      if (claim) return claim;
    } catch { /* desktop pet can restart while the bounded wait continues */ }
    await delay(450);
  }
  try {
    await sendRequest("event.publish", {
      ...event,
      eventId: randomUUID(),
      sequence: nextSequence(event.sessionId),
      emittedAt: Date.now(),
      kind: event.kind === "question.asked" ? "question.resolved" : "permission.resolved",
      summary: "桌宠等待已超时，请回 Pi 原窗口处理",
      interaction: undefined,
    });
  } catch { /* timeout fallback must not create another failure */ }
  return null;
}

async function completeClaim(claim: any, success: boolean, error?: string) {
  await sendRequest("interaction.response.complete", {
    responseId: claim.responseId,
    claimToken: claim.claimToken,
    success,
    error,
  });
}

function sendRequest(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    let discovery: any;
    try { discovery = JSON.parse(readFileSync(discoveryPath(), "utf8")); } catch (error) { reject(error); return; }
    if (discovery.app !== APP_ID || discovery.version !== PROTOCOL_VERSION || !discovery.endpoint || !discovery.token) {
      reject(new Error("Invalid desktop pet discovery"));
      return;
    }
    const id = randomUUID();
    const socket = createConnection(discovery.endpoint);
    let body = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1_200);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, version: PROTOCOL_VERSION, token: discovery.token, method, params })}\n`));
    socket.on("timeout", () => fail(new Error("Desktop pet request timed out")));
    socket.on("error", fail);
    socket.on("data", (chunk: string) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response.id !== id || response.app !== APP_ID || !response.ok) return fail(new Error("Invalid desktop pet response"));
        settled = true;
        socket.end();
        resolve(response.result);
      } catch (error) { fail(error as Error); }
    });
  });
}

function discoveryPath() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "AgentPetHub", "runtime", "ipc.json");
}

function nextSequence(sessionId: string) {
  const next = (sequenceBySession.get(sessionId) || 0) + 1;
  sequenceBySession.set(sessionId, next);
  return next;
}

function piSessionId(ctx: any): string {
  return String(ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.() || "pi-default");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { answer: null } };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
