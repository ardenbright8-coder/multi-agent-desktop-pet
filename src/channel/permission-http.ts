// Claude Code 权限「直拨线」（2026-11-04，学 clawd-on-desk 的做法）。
//
// 以前：Claude 起一个钩子脚本，脚本挂着等桌宠点；终端先答了没人告诉桌宠，
//       只能靠「钩子进程还活没活、聊天记录动没动」去猜，猜错了面板两三秒就自己收，人卡在终端。
// 现在：Claude 用官方的网址钩子（type: "http"）直接把权限请求 POST 到这里，连接一直挂着等答案。
//       Claude 那头挂断（终端先答了／超时）＝明确信号，立刻收窗，不用猜。
//
// 只给 Claude 权限这一条用。各家事件主链路照旧走随机命名管道（见本夹 AGENTS.md）。
// 面板长相、「以后都允许」、大事判断这些规矩全在钩子脚本里，这里起它来处理，规矩只有一份。

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AgentHub } from "../events/hub";
import { createLogger } from "../shared/log";
import { dataDirectory } from "../shared/paths";

/** 避开 clawd-on-desk 的 23333–23337，免得两只桌宠抢一个号。 */
export const PERMISSION_HTTP_PORTS = [23380, 23381, 23382, 23383, 23384] as const;
export const PERMISSION_HTTP_PATH = "/agent-pet/permission/claude-code";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const log = createLogger("permission");

export interface PermissionHttpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface PermissionHttpOptions {
  /** 钩子脚本放在哪（integrations 块管，app.ts 注入）。 */
  hookScript: () => string;
  ports?: readonly number[];
}

export async function startPermissionHttp(hub: AgentHub, options: PermissionHttpOptions): Promise<PermissionHttpServer | null> {
  const children = new Set<ChildProcess>();
  const server = createServer((req, res) => { void handle(req, res); });
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0; // 等人点，最长由 Claude 那边的 timeout 定，这里不提前掐
  server.headersTimeout = 30_000;

  let sequence = 0;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress || "";
    if (req.method !== "POST" || req.url !== PERMISSION_HTTP_PATH || !/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(remote)) {
      res.writeHead(404).end();
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      log.出事("直拨：请求体读不出来", error, "permission-http");
      res.writeHead(400).end();
      return;
    }
    let payload: { session_id?: unknown; tool_name?: unknown };
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "claude-code-default";
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "?";
    const script = options.hookScript();
    if (!existsSync(script)) {
      // 回空 200：Claude 照常在终端问，不卡它
      log.出事(`直拨：钩子脚本不在 ${script}，交回终端问`, undefined, "permission-http");
      res.writeHead(200, { "Content-Type": "application/json" }).end();
      return;
    }

    const child = spawn(process.execPath, [script, "claude-code", "PermissionRequest"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENT_PET_HTTP_GATE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(child);
    let requestId = "";
    let stdout = "";
    let stderr = "";
    let finished = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const match = /PET_REQUEST_ID=(\S+)/.exec(stderr);
      if (match) requestId = match[1];
    });
    child.on("error", (error) => log.出事("直拨：钩子脚本起不来", error, "permission-http"));
    child.on("close", () => {
      children.delete(child);
      if (finished) return;
      finished = true;
      const text = stdout.trim();
      res.writeHead(200, { "Content-Type": "application/json" }).end(text.startsWith("{") ? text : undefined);
      log.记(`直拨：${tool} 答完交回 Claude（${text ? "桌宠上有决定" : "没人点，交回终端"}）会话=${sessionId}`, "permission-http");
    });
    // Claude 挂断：终端先答了、或 Claude 那边超时 → 收窗，不留点了没人接的面板
    res.on("close", () => {
      if (finished) return;
      finished = true;
      child.kill();
      clearPending(requestId);
      if (requestId) {
        sequence += 1;
        hub.publish({
          version: 1,
          eventId: randomUUID(),
          sourceInstance: "permission-http",
          sequence,
          emittedAt: Date.now(),
          agent: "claude-code",
          sessionId,
          kind: "permission.resolved",
          requestId,
        });
      }
      log.记(`直拨：Claude 挂断了（终端先答了或超时），收起桌宠的窗 ${tool} 会话=${sessionId}`, "permission-http");
    });
    child.stdin.end(body);
  }

  for (const port of options.ports ?? PERMISSION_HTTP_PORTS) {
    if (await listen(server, port)) {
      const url = `http://127.0.0.1:${port}${PERMISSION_HTTP_PATH}`;
      log.记(`直拨线已就绪 ${url}`, "permission-http");
      return {
        port,
        url,
        close: () => new Promise<void>((resolve) => {
          for (const child of children) child.kill();
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
      };
    }
  }
  log.出事(`直拨线一个端口都没占上（${(options.ports ?? PERMISSION_HTTP_PORTS).join("、")}），Claude 权限退回老办法`, undefined, "permission-http");
  return null;
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => { server.off("listening", onListening); resolve(false); };
    const onListening = () => { server.off("error", onError); resolve(true); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 钩子留的「待答」记号，挂断时一并清掉（跟钩子脚本 pendingDir 同一处）。 */
function clearPending(requestId: string): void {
  if (!requestId || !/^[\w-]+$/.test(requestId)) return;
  try { unlinkSync(join(dataDirectory(), "pending-permission", `${requestId}.json`)); } catch { /* 没有就算了 */ }
}
