import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { APP_ID, MAX_FRAME_BYTES, PROTOCOL_VERSION, type AgentEvent, type InteractionResponseClaim, type RpcRequest, type RpcResponse, type SearchHit, type SearchQuery } from "../shared/protocol";
import { discoveryPath } from "./paths";
import type { DiscoveryDocument } from "./ipc-server";

export class LocalIpcClient {
  async request(method: RpcRequest["method"], params?: unknown, timeoutMs = 1_500): Promise<unknown> {
    const discovery = this.readDiscovery();
    const id = randomUUID();
    const request: RpcRequest = { id, version: PROTOCOL_VERSION, token: discovery.token, method, params };
    const response = await sendFrame(discovery.endpoint, request, timeoutMs);
    if (response.id !== id) throw new Error("IPC response ID mismatch");
    if (response.app !== APP_ID) throw new Error("IPC endpoint identity mismatch");
    if (response.version !== PROTOCOL_VERSION) throw new Error("IPC protocol version mismatch");
    if (!response.ok) throw new Error(`${response.error?.code || "ipc-error"}: ${response.error?.message || "Unknown error"}`);
    return response.result;
  }

  publish(event: AgentEvent): Promise<unknown> {
    return this.request("event.publish", event);
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    return this.request("search.query", query) as Promise<SearchHit[]>;
  }

  claimInteraction(binding: Record<string, string>): Promise<InteractionResponseClaim | null> {
    return this.request("interaction.response.claim", binding) as Promise<InteractionResponseClaim | null>;
  }

  completeInteraction(responseId: string, claimToken: string, success: boolean, error?: string): Promise<unknown> {
    return this.request("interaction.response.complete", { responseId, claimToken, success, error });
  }

  private readDiscovery(): DiscoveryDocument {
    const parsed = JSON.parse(readFileSync(discoveryPath(), "utf8")) as DiscoveryDocument;
    if (parsed.app !== APP_ID || parsed.version !== PROTOCOL_VERSION || !parsed.endpoint || !parsed.token) {
      throw new Error("Invalid IPC discovery document");
    }
    return parsed;
  }
}

function sendFrame(endpoint: string, request: RpcRequest, timeoutMs: number): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let body = "";
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("timeout", () => finishError(new Error("IPC request timed out")));
    socket.on("error", finishError);
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_FRAME_BYTES) return finishError(new Error("IPC response too large"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline)) as RpcResponse;
        settled = true;
        socket.end();
        resolve(response);
      } catch {
        finishError(new Error("IPC response is not valid JSON"));
      }
    });
  });
}
