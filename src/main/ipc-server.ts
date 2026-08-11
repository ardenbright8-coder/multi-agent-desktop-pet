import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID, MAX_FRAME_BYTES, PROTOCOL_VERSION, type RpcRequest, type RpcResponse, type SearchQuery } from "../shared/protocol";
import { writeJsonAtomic } from "./atomic-file";
import type { AgentHub } from "./hub";
import { discoveryPath, runtimeDirectory } from "./paths";

export interface DiscoveryDocument {
  app: string;
  version: number;
  endpoint: string;
  token: string;
  ownerPid: number;
  createdAt: number;
}

export class LocalIpcServer {
  private server: Server | null = null;
  private token = "";
  private endpoint = "";
  readonly discoveryPath = discoveryPath();

  constructor(private readonly hub: AgentHub) {}

  async start(): Promise<DiscoveryDocument> {
    if (this.server) throw new Error("IPC server is already running");
    mkdirSync(runtimeDirectory(), { recursive: true });
    this.token = randomBytes(32).toString("base64url");
    const suffix = randomBytes(8).toString("hex");
    this.endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\agent-pet-hub-${suffix}-${process.pid}`
      : join(tmpdir(), `agent-pet-hub-${suffix}-${process.pid}.sock`);
    if (process.platform !== "win32" && existsSync(this.endpoint)) unlinkSync(this.endpoint);

    this.server = createServer((socket) => this.handleSocket(socket));
    this.server.on("error", (error) => this.hub.emit("server-error", error));
    await new Promise<void>((resolve, reject) => {
      const server = this.server as Server;
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.endpoint, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const discovery: DiscoveryDocument = {
      app: APP_ID,
      version: PROTOCOL_VERSION,
      endpoint: this.endpoint,
      token: this.token,
      ownerPid: process.pid,
      createdAt: Date.now(),
    };
    writeJsonAtomic(this.discoveryPath, discovery);
    return discovery;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = JSON.parse(readFileSync(this.discoveryPath, "utf8")) as DiscoveryDocument;
      if (current.ownerPid === process.pid && current.token === this.token && current.endpoint === this.endpoint) {
        unlinkSync(this.discoveryPath);
      }
    } catch {
      // A newer process may already own discovery; never remove it blindly.
    }
    if (process.platform !== "win32" && this.endpoint && existsSync(this.endpoint)) unlinkSync(this.endpoint);
  }

  private handleSocket(socket: Socket): void {
    let body = "";
    let closed = false;
    socket.setEncoding("utf8");
    socket.setTimeout(2_000);
    const finish = (response: RpcResponse) => {
      if (closed) return;
      closed = true;
      let serialized = JSON.stringify(response);
      if (Buffer.byteLength(serialized, "utf8") > MAX_FRAME_BYTES) {
        serialized = JSON.stringify(errorResponse(response.id, "response-too-large", "响应超过 64 KiB，请缩小查询范围"));
      }
      socket.end(`${serialized}\n`);
    };
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => { closed = true; });
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_FRAME_BYTES) {
        finish(errorResponse("unknown", "frame-too-large", "请求超过 64 KiB"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      const frame = body.slice(0, newline);
      let request: RpcRequest;
      try {
        request = JSON.parse(frame) as RpcRequest;
      } catch {
        finish(errorResponse("unknown", "bad-json", "请求不是合法 JSON"));
        return;
      }
      try {
        void Promise.resolve(this.dispatch(request)).then(finish).catch(() => {
          finish(errorResponse(request.id || "unknown", "internal-error", "事件中心处理请求时出错"));
        });
      } catch {
        finish(errorResponse(request.id || "unknown", "internal-error", "事件中心处理请求时出错"));
      }
    });
  }

  private dispatch(request: RpcRequest): RpcResponse {
    if (!request || typeof request.id !== "string") return errorResponse("unknown", "bad-request", "缺少请求 ID");
    if (request.version !== PROTOCOL_VERSION) return errorResponse(request.id, "version-mismatch", "协议版本不匹配");
    if (!secureEqual(request.token, this.token)) return errorResponse(request.id, "unauthorized", "连接令牌不正确");

    switch (request.method) {
      case "hello":
        return okResponse(request.id, { healthy: true, ownerPid: process.pid, protocolVersion: PROTOCOL_VERSION });
      case "event.publish":
        return okResponse(request.id, this.hub.publish(request.params));
      case "snapshot.get":
        return okResponse(request.id, this.hub.snapshot());
      case "search.query":
        return okResponse(request.id, this.hub.search(normalizeSearchQuery(request.params)));
      case "diagnostics.get":
        return okResponse(request.id, this.hub.diagnostics());
      case "interaction.response.claim":
        return okResponse(request.id, this.hub.claimInteractionResponse(request.params));
      case "interaction.response.complete":
        return okResponse(request.id, this.hub.completeInteractionResponse(request.params));
      default:
        return errorResponse(request.id, "method-not-found", "不支持的方法");
    }
  }
}

function normalizeSearchQuery(value: unknown): SearchQuery {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid search query");
  const raw = value as Record<string, unknown>;
  const stringField = (key: string, max: number): string | undefined => {
    const item = raw[key];
    if (item === undefined) return undefined;
    if (typeof item !== "string") throw new Error(`invalid ${key}`);
    return item.slice(0, max);
  };
  const limit = raw.limit === undefined ? undefined : Number(raw.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("invalid limit");
  return {
    text: stringField("text", 500),
    agent: stringField("agent", 80),
    project: stringField("project", 300),
    sessionId: stringField("sessionId", 200),
    kind: stringField("kind", 80) as SearchQuery["kind"],
    limit: limit === undefined ? undefined : Math.min(limit, 60),
  };
}

function secureEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function okResponse(id: string, result: unknown): RpcResponse {
  return { id, version: PROTOCOL_VERSION, app: APP_ID, ok: true, result };
}

function errorResponse(id: string, code: string, message: string): RpcResponse {
  return { id, version: PROTOCOL_VERSION, app: APP_ID, ok: false, error: { code, message } };
}
