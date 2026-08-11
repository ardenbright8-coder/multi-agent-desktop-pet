// multi-agent-desktop-pet managed generic hook bridge v1
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const APP_ID = "multi-agent-desktop-pet";
const PROTOCOL_VERSION = 1;
const EVENT_KINDS = new Set([
  "session.started", "context.updated", "state.thinking", "state.working",
  "permission.requested", "permission.resolved", "question.asked", "question.resolved",
  "task.completed", "task.failed", "session.ended", "heartbeat",
]);

const [agentArg = "generic", hookArg = "context.updated"] = process.argv.slice(2);

try {
  const input = await readInput();
  const event = translate(agentArg, hookArg, input);
  if (event) await publish(event);
} catch {
  // Agent reporting must always fail open.
}

function discoveryPath() {
  const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(root, "AgentPetHub", "runtime", "ipc.json");
}

async function readInput() {
  if (process.stdin.isTTY) return {};
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 256 * 1024) return {};
  }
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { return { message: body.slice(0, 2_000) }; }
}

function translate(agent, hook, input) {
  const normalizedAgent = clean(agent, 80) || "generic";
  const normalizedHook = String(hook || "").toLowerCase();
  const directKind = EVENT_KINDS.has(hook) ? hook : null;
  const kind = directKind || kindFromHook(normalizedHook, input);
  if (!kind) return null;

  const cwd = firstString(input.cwd, input.working_directory, input.project_dir, process.env.CLAUDE_PROJECT_DIR, process.cwd());
  const sessionId = firstString(input.session_id, input.sessionId, input.conversation_id, input.task_id, `${normalizedAgent}-default`);
  const tool = firstString(input.tool_name, input.toolName, input.tool, input.name);
  const toolInput = objectValue(input.tool_input, input.toolInput, input.input, input.arguments);
  const target = targetFrom(toolInput, input);
  const reason = firstString(
    input.reason,
    input.message,
    input.error?.message,
    typeof input.error === "string" ? input.error : undefined,
    reasonFromHook(normalizedAgent, normalizedHook, tool),
  );
  const requestId = firstString(input.request_id, input.requestId, input.tool_use_id, input.toolUseId, input.id);
  const summary = firstString(input.summary, input.title, summaryFromHook(normalizedAgent, normalizedHook, tool));
  const emittedAt = Date.now();

  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: `${normalizedAgent}-hook:${process.pid}:${randomBytes(5).toString("hex")}`,
    sequence: 1,
    emittedAt,
    agent: normalizedAgent,
    sessionId: clean(sessionId, 200) || `${normalizedAgent}-default`,
    kind,
    project: cwd ? basename(cwd) : normalizedAgent,
    cwd: clean(cwd, 1_000),
    title: clean(firstString(input.session_title, input.title, `${agentLabel(normalizedAgent)} 会话`), 500),
    summary: clean(summary, 2_000),
    reason: clean(reason, 2_000),
    tool: clean(tool, 120),
    target: clean(target, 2_000),
    paths: pathList(toolInput, input),
    requestId: clean(requestId, 200),
    metadata: safeMetadata(toolInput),
  };
}

function kindFromHook(hook, input) {
  if (hook.includes("permission")) return hook.includes("resolved") ? "permission.resolved" : "permission.requested";
  if (hook.includes("elicitation") || hook.includes("question")) return hook.includes("resolved") || hook.includes("replied") ? "question.resolved" : "question.asked";
  if (hook.includes("sessionend") || hook.includes("session.end") || hook === "end") return "session.ended";
  if (hook.includes("sessionstart") || hook.includes("session.start") || hook === "start") return "session.started";
  if (hook.includes("stopfailure") || hook.includes("toolusefailure") || hook.includes("tool.error") || hook.includes("failed")) return "task.failed";
  if (hook === "stop" || hook.includes("task.completed") || hook.includes("complete")) return "task.completed";
  if (hook.includes("pretool") || hook.includes("posttool") || hook.includes("tool.") || hook.includes("subagent")) return "state.working";
  if (hook.includes("prompt") || hook.includes("thinking")) return "state.thinking";
  if (hook.includes("notification")) {
    const notification = String(input.notification_type || input.type || input.message || "").toLowerCase();
    return notification.includes("permission") || notification.includes("input") ? "permission.requested" : "context.updated";
  }
  if (hook.includes("heartbeat")) return "heartbeat";
  return "context.updated";
}

function summaryFromHook(agent, hook, tool) {
  const label = agentLabel(agent);
  if (hook.includes("sessionstart")) return `${label} 会话已经开始`;
  if (hook.includes("prompt")) return `${label} 正在理解任务`;
  if (hook.includes("pretool")) return `正在使用 ${tool || "工具"}`;
  if (hook.includes("posttool")) return `已完成 ${tool || "工具"}，继续处理任务`;
  if (hook.includes("permission")) return `${label} 需要你处理权限`;
  if (hook.includes("elicitation") || hook.includes("question")) return `${label} 正在等你回答`;
  if (hook === "stop") return `${label} 已经完成这一轮任务`;
  if (hook.includes("failure") || hook.includes("failed")) return `${label} 遇到错误，需要回来查看`;
  if (hook.includes("sessionend")) return `${label} 会话已经结束`;
  return `${label} 状态已更新`;
}

function reasonFromHook(agent, hook, tool) {
  const label = agentLabel(agent);
  if (hook.includes("permission")) return `${label} 请求使用 ${tool || "当前工具"} 继续执行`;
  if (hook.includes("pretool")) return "正在执行当前任务所需的工具";
  if (hook.includes("failure") || hook.includes("failed")) return `${tool || "工具"} 执行失败`;
  return undefined;
}

function targetFrom(toolInput, input) {
  for (const source of [toolInput, input]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["file_path", "filePath", "path", "command", "url", "query", "pattern", "prompt"]) {
      if (typeof source[key] === "string" && source[key].trim()) return source[key];
    }
  }
  return undefined;
}

function pathList(toolInput, input) {
  const values = [];
  for (const source of [toolInput, input]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["file_path", "filePath", "path"]) if (typeof source[key] === "string") values.push(clean(source[key], 1_000));
    if (Array.isArray(source.paths)) values.push(...source.paths.map((value) => clean(value, 1_000)));
  }
  const filtered = values.filter(Boolean).slice(0, 20);
  return filtered.length ? filtered : undefined;
}

function safeMetadata(input) {
  if (!input || typeof input !== "object") return undefined;
  const output = {};
  for (const key of ["file_path", "filePath", "path", "command", "url", "query", "pattern"]) {
    if (typeof input[key] === "string") output[key] = clean(input[key], 1_800);
  }
  return Object.keys(output).length ? output : undefined;
}

function objectValue(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function clean(value, max) {
  if (typeof value !== "string") return undefined;
  const redacted = value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'`,;]+/gi, "$1[已遮盖]")
    .replace(/\b(sk-[a-z0-9_-]{12,})\b/gi, "[已遮盖]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`,;]+/gi, "$1[已遮盖]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
  return redacted ? redacted.slice(0, max) : undefined;
}

function agentLabel(agent) {
  return ({ "claude-code": "Claude Code", opencode: "OpenCode", pi: "Pi", hermes: "Hermes" })[agent] || agent;
}

async function publish(event) {
  const discovery = JSON.parse(readFileSync(discoveryPath(), "utf8"));
  if (discovery.app !== APP_ID || discovery.version !== PROTOCOL_VERSION || !discovery.endpoint || !discovery.token) return;
  const id = randomUUID();
  const request = { id, version: PROTOCOL_VERSION, token: discovery.token, method: "event.publish", params: event };
  await new Promise((resolve, reject) => {
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
    socket.setTimeout(650);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("timeout", () => fail(new Error("timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) return fail(new Error("response too large"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response.id !== id || response.app !== APP_ID || !response.ok) return fail(new Error("bad response"));
        settled = true;
        socket.end();
        resolve(response.result);
      } catch (error) { fail(error); }
    });
  });
}
