// 可选的浏览器采集适配器；不是桌宠 Agent 命名管道主链路。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";
import { QuotaStore } from "./model";

export interface ReceiverConfig { port: number; token: string; serviceId: string }
export interface QuotaReceiver { config: ReceiverConfig; installUrl: string; close(): Promise<void> }
export async function startQuotaReceiver(root: string, store: QuotaStore, template: string, changed: () => void, forcePort?: number): Promise<QuotaReceiver> {
  const file = join(root, "receiver.json");
  let config: ReceiverConfig = { port: 0, token: randomBytes(32).toString("hex"), serviceId: randomUUID() };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as ReceiverConfig;
    if (Number.isInteger(saved.port) && saved.port >= 0 && saved.port <= 65535 && /^[a-f0-9]{64}$/.test(saved.token) && /^[a-f0-9-]{36}$/.test(saved.serviceId)) config = saved;
  } catch { /* 首次使用 */ }
  const nonce = randomUUID();
  const authorized = (req: IncomingMessage): boolean => {
    const actual = Buffer.from(req.headers.authorization || ""); const expected = Buffer.from(`Bearer ${config.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const expectedHost = `127.0.0.1:${config.port}`;
    if (req.headers.host !== expectedHost) { json(res, 403, { error: "host" }); return; }
    if (req.headers.origin && req.headers.origin !== "https://gemini.google.com" && !req.headers.origin.startsWith("chrome-extension://")) { json(res, 403, { error: "origin" }); return; }
    if (req.method === "GET" && req.url === "/meta") { json(res, 200, { service: "gemini-quota", id: config.serviceId, version: 1 }); return; }
    if (req.method === "GET" && req.url === `/${nonce}/collector.user.js`) {
      const bridge = { url: `http://127.0.0.1:${config.port}`, token: config.token, serviceId: config.serviceId };
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(template.replace("/*__GEMINI_DESKTOP_BRIDGE__*/null", JSON.stringify(bridge))); return;
    }
    if (!authorized(req)) { json(res, 401, { error: "auth" }); return; }
    if (req.method === "GET" && req.url === "/snapshot") { json(res, 200, { accounts: store.snapshot() }); return; }
    if (req.method !== "POST" || req.url !== "/ingest") { json(res, 404, { error: "route" }); return; }
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "json required" }); return; }
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_768) { if (!res.writableEnded) json(res, 413, { error: "size" }); chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try { const ok = store.ingest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); if (ok) changed(); json(res, ok ? 200 : 400, { ok }); }
      catch { json(res, 400, { error: "invalid reading" }); }
    });
    req.on("error", () => { if (!res.writableEnded) json(res, 400, { error: "request" }); });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(forcePort ?? config.port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  config.port = (server.address() as { port: number }).port;
  writeJsonAtomic(file, config);
  const installUrl = `http://127.0.0.1:${config.port}/${nonce}/collector.user.js`;
  writeJsonAtomic(join(root, "discovery.json"), { port: config.port, serviceId: config.serviceId, installUrl, ownerPid: process.pid });
  return { config, installUrl, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
