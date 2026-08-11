// multi-agent-desktop-pet managed opencode plugin v1
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const APP_ID = "multi-agent-desktop-pet";
const PROTOCOL_VERSION = 1;
const sourceInstance = `opencode:${process.pid}:${randomBytes(6).toString("hex")}`;
const sequenceBySession = new Map();
const contextBySession = new Map();
const lastStateBySession = new Map();
const pendingStateBySession = new Map();
const sendQueueBySession = new Map();

function discoveryPath() {
  const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(root, "AgentPetHub", "runtime", "ipc.json");
}

function nextSequence(sessionId) {
  const next = (sequenceBySession.get(sessionId) || 0) + 1;
  sequenceBySession.set(sessionId, next);
  return next;
}

function sessionIdFrom(event) {
  const properties = event?.properties || {};
  return properties.sessionID || properties.sessionId || properties.info?.id || event?.sessionID || "opencode-default";
}

function rememberContext(event, fallbackDirectory) {
  const properties = event?.properties || {};
  const info = properties.info || {};
  const sessionId = sessionIdFrom(event);
  const previous = contextBySession.get(sessionId) || {};
  contextBySession.set(sessionId, {
    title: typeof info.title === "string" ? info.title : previous.title,
    cwd: typeof info.directory === "string" ? info.directory : previous.cwd || fallbackDirectory,
  });
}

function makeEvent(sessionId, kind, details = {}) {
  const context = contextBySession.get(sessionId) || {};
  const cwd = details.cwd || context.cwd || "";
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance,
    sequence: nextSequence(sessionId),
    emittedAt: Date.now(),
    agent: "opencode",
    sessionId,
    kind,
    project: details.project || (cwd ? basename(cwd) : "OpenCode"),
    cwd,
    title: details.title || context.title || "OpenCode 会话",
    summary: details.summary,
    reason: details.reason,
    tool: details.tool,
    target: details.target,
    paths: details.paths,
    requestId: details.requestId,
    metadata: sanitizeMetadataForWire(details.metadata),
  };
}

function publish(event) {
  const previous = sendQueueBySession.get(event.sessionId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => sendWithRetry(event));
  sendQueueBySession.set(event.sessionId, task);
  void task.finally(() => {
    if (sendQueueBySession.get(event.sessionId) === task) sendQueueBySession.delete(event.sessionId);
  });
  return task;
}

function publishState(sessionId, kind, details) {
  const stateKey = `${kind}:${details?.tool || ""}:${details?.summary || ""}`;
  if (lastStateBySession.get(sessionId) === stateKey || pendingStateBySession.get(sessionId) === stateKey) return;
  pendingStateBySession.set(sessionId, stateKey);
  const event = makeEvent(sessionId, kind, details);
  void publish(event).then((accepted) => {
    if (accepted) lastStateBySession.set(sessionId, stateKey);
  }).finally(() => {
    if (pendingStateBySession.get(sessionId) === stateKey) pendingStateBySession.delete(sessionId);
  });
}

async function sendWithRetry(event) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await sendRequest("event.publish", event);
      if (result?.status === "accepted" || result?.status === "duplicate") return true;
      if (result?.status === "stale" || result?.status === "invalid") return false;
    } catch {
      if (attempt < 2) await delay(100 * (attempt + 1));
    }
  }
  return false;
}

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    let discovery;
    try {
      discovery = JSON.parse(readFileSync(discoveryPath(), "utf8"));
    } catch (error) {
      reject(error);
      return;
    }
    if (discovery.app !== APP_ID || discovery.version !== PROTOCOL_VERSION || !discovery.endpoint || !discovery.token) {
      reject(new Error("invalid discovery"));
      return;
    }
    const id = randomUUID();
    const socket = createConnection(discovery.endpoint);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(900);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, version: PROTOCOL_VERSION, token: discovery.token, method, params })}\n`));
    socket.on("timeout", () => fail(new Error("timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) return fail(new Error("response too large"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response.id !== id || response.app !== APP_ID || !response.ok) return fail(new Error("bad response"));
        settled = true;
        socket.end();
        resolve(response.result);
      } catch (error) {
        fail(error);
      }
    });
  });
}

function targetFrom(metadata, patterns) {
  if (Array.isArray(patterns) && patterns.length) return redactSensitiveText(patterns.join("、")).slice(0, 1800);
  if (!metadata || typeof metadata !== "object") return "未提供目标";
  for (const key of ["filePath", "path", "command", "url", "query", "pattern"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) return redactSensitiveText(metadata[key]).slice(0, 1800);
  }
  return "未提供目标";
}

function sanitizeMetadataForWire(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const output = {};
  for (const key of ["filePath", "path", "command", "url", "query", "pattern"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) output[key] = redactSensitiveText(value).slice(0, 1800);
  }
  return Object.keys(output).length ? output : undefined;
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'`,;]+/gi, "$1[已遮盖]")
    .replace(/\b(sk-[a-z0-9_-]{12,})\b/gi, "[已遮盖]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`,;]+/gi, "$1[已遮盖]");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function translateEvent(event, directory) {
  const properties = event?.properties || {};
  const sessionId = sessionIdFrom(event);
  rememberContext(event, directory);
  switch (event?.type) {
    case "session.created":
      publish(makeEvent(sessionId, "session.started", { summary: "OpenCode 会话已经开始" }));
      break;
    case "session.updated":
      publish(makeEvent(sessionId, "context.updated", { summary: contextBySession.get(sessionId)?.title || "会话信息已更新" }));
      break;
    case "session.status":
      if (properties.status?.type === "busy") publishState(sessionId, "state.thinking", { summary: "正在理解任务和安排步骤" });
      break;
    case "session.idle":
      lastStateBySession.delete(sessionId);
      publish(makeEvent(sessionId, "task.completed", { summary: "OpenCode 已经完成这一轮任务" }));
      break;
    case "session.error":
      lastStateBySession.delete(sessionId);
      publish(makeEvent(sessionId, "task.failed", { summary: "OpenCode 遇到错误，需要回来查看", reason: String(properties.error?.message || properties.error || "未提供错误详情") }));
      break;
    case "session.deleted":
      publish(makeEvent(sessionId, "session.ended", { summary: "OpenCode 会话已经结束" }));
      contextBySession.delete(sessionId);
      lastStateBySession.delete(sessionId);
      break;
    case "server.instance.disposed": {
      const known = [...contextBySession.keys()];
      for (const knownSessionId of known.length ? known : [sessionId]) {
        publish(makeEvent(knownSessionId, "session.ended", { summary: "OpenCode 实例已经关闭" }));
        contextBySession.delete(knownSessionId);
        lastStateBySession.delete(knownSessionId);
      }
      break;
    }
    case "permission.updated":
    case "permission.v2.asked":
    case "permission.asked": {
      const permission = properties.permission || properties.type || "unknown";
      const metadata = properties.metadata && typeof properties.metadata === "object" ? properties.metadata : {};
      const patterns = Array.isArray(properties.patterns) ? properties.patterns : properties.pattern ? [properties.pattern] : [];
      const target = targetFrom(metadata, patterns);
      publish(makeEvent(sessionId, "permission.requested", {
        summary: contextBySession.get(sessionId)?.title || "正在处理当前任务",
        reason: properties.message || `OpenCode 请求使用 ${permission} 继续执行`,
        tool: permission,
        target,
        paths: patterns.slice(0, 20),
        requestId: properties.id || properties.requestID,
        metadata,
      }));
      break;
    }
    case "permission.replied":
      publish(makeEvent(sessionId, "permission.resolved", {
        summary: "权限请求已经在 OpenCode 中处理",
        requestId: properties.requestID || properties.id || properties.permissionID,
      }));
      break;
    case "question.asked": {
      const questions = Array.isArray(properties.questions) ? properties.questions : [];
      const target = questions.map((question) => question?.question || question?.header || question?.text).filter(Boolean).join("；").slice(0, 1800) || "OpenCode 正在等待你的回答";
      publish(makeEvent(sessionId, "question.asked", {
        summary: contextBySession.get(sessionId)?.title || "正在处理当前任务",
        reason: "OpenCode 需要你补充信息后才能继续",
        tool: "question",
        target,
        requestId: properties.requestID || properties.id,
      }));
      break;
    }
    case "question.replied":
    case "question.rejected":
      publish(makeEvent(sessionId, "question.resolved", {
        summary: "问题已经在 OpenCode 中处理",
        requestId: properties.requestID || properties.id,
      }));
      break;
  }
}

export default async function MultiAgentDesktopPetPlugin(ctx) {
  const directory = typeof ctx?.directory === "string" ? ctx.directory : "";
  return {
    event: async ({ event }) => {
      try { translateEvent(event, directory); } catch { /* state reporting must never block OpenCode */ }
    },
    "tool.execute.before": async (input, output) => {
      try {
        const sessionId = input?.sessionID || input?.sessionId || "opencode-default";
        const tool = input?.tool || "tool";
        const args = output?.args && typeof output.args === "object" ? output.args : {};
        const target = targetFrom(args, []);
        publishState(sessionId, "state.working", {
          summary: `正在使用 ${tool}`,
          reason: "正在执行当前任务所需的工具",
          tool,
          target,
          metadata: args,
          cwd: directory,
        });
      } catch { /* fail open */ }
    },
    "tool.execute.after": async (input) => {
      try {
        const sessionId = input?.sessionID || input?.sessionId || "opencode-default";
        publishState(sessionId, "state.working", { summary: `已完成 ${input?.tool || "工具"}，继续处理任务`, tool: input?.tool, cwd: directory });
      } catch { /* fail open */ }
    },
  };
}
