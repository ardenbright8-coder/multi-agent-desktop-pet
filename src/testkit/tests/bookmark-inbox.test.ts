// 收信模块单测：mock 一个 ntfy 邮局（本地 http server），不连真邮局。
// 覆盖：协议消息入库+回执原样回发、dedupeKey 重发幂等但回执照发、非协议消息跳过、配置缺失不启动不炸。

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import { readInboxConfig, startBookmarkInbox } from "../../bookmark/inbox";

/** mock 邮局：GET /<topic>/json 吐给定的事件行（吐完 end，触发客户端重连）；POST / 收回执。 */
function startMockNtfy(topic: string, eventLines: string[]): Promise<{
  server: Server;
  url: string;
  receipts: { topic?: string; title?: string; message?: string }[];
}> {
  const receipts: { topic?: string; title?: string; message?: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url?.startsWith(`/${topic}/json`)) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const line of eventLines) res.write(line + "\n");
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { receipts.push(JSON.parse(body)); } catch { /* 坏body忽略 */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "receipt-1" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, receipts });
    });
  });
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-pet-bookmark-inbox-"));
}

function writeConfig(root: string, overrides: Record<string, unknown>): string {
  const path = join(root, "ntfy.json");
  writeFileSync(path, JSON.stringify({
    server: "http://127.0.0.1:1",
    upTopic: "bookmark-up",
    receiptTopic: "bookmark-receipt",
    user: "pc-receiver",
    pass: "test-pass",
    ...overrides,
  }), "utf8");
  return path;
}

function businessMessage(content: string, dedupeKey: string, assignee = ""): string {
  return JSON.stringify({ v: 1, type: "note", content, assignee, ts: 1, dedupeKey });
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(condition(), "waitFor 超时");
}

test("inbox 收协议消息：入库+回执原样回发+刷新回调", async () => {
  const root = tempRoot();
  const payload = businessMessage("手机记的一条", "key-inbox-1", "Claude");
  const mock = await startMockNtfy("bookmark-up", [
    JSON.stringify({ id: "open-1", event: "open" }),
    JSON.stringify({ id: "msg-1", event: "message", message: payload }),
  ]);
  const configPath = writeConfig(root, { server: mock.url });
  const store = new BookmarkStore(join(root, "bookmarks.json"));
  let changed = 0;
  try {
    const handle = startBookmarkInbox({
      store,
      onInboxChanged: () => { changed += 1; },
      configPath,
      reconnectBaseMs: 10,
    });
    await waitFor(() => store.count() === 1);
    await waitFor(() => mock.receipts.length >= 1);
    assert.equal(store.list()[0]?.text, "手机记的一条");
    assert.equal(store.list()[0]?.assignee, "Claude");
    assert.equal(store.list()[0]?.dedupeKey, "key-inbox-1");
    assert.equal(mock.receipts[0]?.topic, "bookmark-receipt");
    assert.equal(mock.receipts[0]?.title, "已收录");
    assert.equal(mock.receipts[0]?.message, payload); // 回执=原业务JSON原样回发
    assert.ok(changed >= 1);
    handle.stop();
  } finally {
    mock.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox dedupeKey 重发：只入库一条，回执照发两回（幂等不悬挂）", async () => {
  const root = tempRoot();
  const mock = await startMockNtfy("bookmark-up", [
    JSON.stringify({ id: "msg-a", event: "message", message: businessMessage("离线重发场景", "key-dup-1") }),
    JSON.stringify({ id: "msg-b", event: "message", message: businessMessage("离线重发场景", "key-dup-1") }),
  ]);
  const configPath = writeConfig(root, { server: mock.url });
  const store = new BookmarkStore(join(root, "bookmarks.json"));
  try {
    const handle = startBookmarkInbox({ store, configPath, reconnectBaseMs: 10 });
    await waitFor(() => mock.receipts.length >= 2);
    assert.equal(store.count(), 1);
    assert.equal(mock.receipts.length, 2);
    handle.stop();
  } finally {
    mock.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox 非协议消息：跳过不入库不回执", async () => {
  const root = tempRoot();
  const mock = await startMockNtfy("bookmark-up", [
    JSON.stringify({ id: "msg-x", event: "message", message: "这是句人话不是JSON" }),
    JSON.stringify({ id: "msg-y", event: "message", message: JSON.stringify({ content: "没有dedupeKey" }) }),
  ]);
  const configPath = writeConfig(root, { server: mock.url });
  const store = new BookmarkStore(join(root, "bookmarks.json"));
  try {
    const handle = startBookmarkInbox({ store, configPath, reconnectBaseMs: 10 });
    // 给重连+处理留点时间，确认始终没入库没回执。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(store.count(), 0);
    assert.equal(mock.receipts.length, 0);
    handle.stop();
  } finally {
    mock.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox 配置缺失：不启动不炸，stop 可安全调", async () => {
  const root = tempRoot();
  const store = new BookmarkStore(join(root, "bookmarks.json"));
  try {
    const handle = startBookmarkInbox({ store, configPath: join(root, "不存在的配置.json") });
    handle.stop();
    assert.equal(store.count(), 0);
    // 坏配置（缺必填字段）同样不启动。
    const badPath = writeConfig(root, { user: "" });
    const handle2 = startBookmarkInbox({ store, configPath: badPath });
    handle2.stop();
    assert.equal(store.count(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox 配置读取：好配置过、尾斜杠剥掉", () => {
  const root = tempRoot();
  try {
    const path = writeConfig(root, { server: "http://116.62.217.189/" });
    const config = readInboxConfig(path);
    assert.ok(config);
    assert.equal(config.server, "http://116.62.217.189");
    assert.equal(config.upTopic, "bookmark-up");
    assert.equal(config.receiptTopic, "bookmark-receipt");
    assert.equal(config.since, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
