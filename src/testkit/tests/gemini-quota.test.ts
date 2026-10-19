import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaStore, SOURCE_TTL, STALE_AFTER, normalizeMessage } from "../../gemini/model";
import { startQuotaReceiver } from "../../gemini/receiver";
const message = (accountId = "aaaaaaaa", sourceId = "source-0001", observedAt = Date.now()) => ({ kind: "reading", accountId, sourceId, observedAt,
  current: { used: 12, reset: { raw: "8:19", epoch: null } }, weekly: { used: 40, reset: { raw: "10月22日4:19", epoch: null } } });
test("Gemini只接受有效账号、百分比和读取时间", () => {
  const now = Date.now(); assert(normalizeMessage(message()));
  assert.equal(normalizeMessage({ ...message(), accountId: "not-email-or-token" }), null);
  assert.equal(normalizeMessage({ ...message(), current: { used: 101 } }), null);
  assert.equal(normalizeMessage({ ...message(), observedAt: now + 3600000 }, now), null);
});
test("同账号多窗口仍一个球，两个/三个账号分别显示", () => {
  const s = new QuotaStore(); s.ingest(message()); s.ingest(message("aaaaaaaa", "source-0002")); assert.equal(s.snapshot().length, 1);
  s.ingest(message("bbbbbbbb", "source-0003")); s.ingest(message("cccccccc", "source-0004")); assert.equal(s.snapshot().length, 3);
  assert.deepEqual(s.snapshot().map(r => r.label), ["G1", "G2", "G3"]);
});
test("后台取数页不冒充正在使用的账号，但能更新该账号读数", () => {
  const s = new QuotaStore(); s.ingest({ ...message(), monitor: true }); assert.equal(s.snapshot().length, 0);
  s.ingest(message("aaaaaaaa", "chat-source-1")); assert.equal(s.snapshot().length, 1);
  s.ingest({ kind: "bye", accountId: "aaaaaaaa", sourceId: "chat-source-1" }); assert.equal(s.snapshot().length, 0);
});
test("关闭一个来源不隐藏另一个窗口；账号切换不串号", () => {
  const s = new QuotaStore(); s.ingest(message()); s.ingest(message("aaaaaaaa", "source-0002"));
  s.ingest({ kind: "bye", accountId: "aaaaaaaa", sourceId: "source-0001" }); assert.equal(s.snapshot().length, 1);
  s.ingest(message("bbbbbbbb", "source-0002")); assert.deepEqual(s.snapshot().map(r => r.accountId), ["bbbbbbbb"]);
  s.ingest({ kind: "bye", accountId: "aaaaaaaa", sourceId: "source-0002" }); assert.equal(s.snapshot().length, 1);
});
test("读取过时标旧，来源超时隐藏；重置点不自作主张清零", () => {
  const s = new QuotaStore(), now = Date.now(); const m = message("aaaaaaaa", "source-0001", now - STALE_AFTER - 1); m.current.used = 100;
  s.ingest(m, now); assert.equal(s.snapshot(now)[0].stale, true); assert.equal(s.snapshot(now)[0].current.used, 100);
  assert.equal(s.snapshot(now + SOURCE_TTL).length, 0);
});
test("旧标签页的缓存不覆盖新读数", () => {
  const s = new QuotaStore(), now = Date.now(); s.ingest(message("aaaaaaaa", "source-0001", now), now);
  const old = message("aaaaaaaa", "source-0002", now - 60000); old.current.used = 99; s.ingest(old, now);
  assert.equal(s.snapshot(now)[0].current.used, 12);
});
test("缓存不当作活跃账号，重启后等真实来源再显", () => {
  const root = mkdtempSync(join(tmpdir(), "bm-gemini-model-")); const file = join(root, "readings.json");
  try { const a = new QuotaStore(file); a.ingest(message()); const b = new QuotaStore(file); assert.equal(b.snapshot().length, 0); b.ingest(message()); assert.equal(b.snapshot()[0].label, "G1"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test("本机收件器鉴权、安装隔离与生命周期", async () => {
  const root = mkdtempSync(join(tmpdir(), "bm-gemini-receiver-")), s = new QuotaStore();
  const r = await startQuotaReceiver(root, s, "const BRIDGE=/*__GEMINI_DESKTOP_BRIDGE__*/null;", () => {}, 0);
  const base = `http://127.0.0.1:${r.config.port}`, headers = { Authorization: `Bearer ${r.config.token}`, "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(base + "/snapshot")).status, 401);
    assert.equal((await fetch(base + "/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message()) })).status, 401);
    assert.equal((await fetch(base + "/ingest", { method: "POST", headers: { ...headers, Origin: "https://evil.invalid" }, body: JSON.stringify(message()) })).status, 403);
    assert.equal((await fetch(base + "/ingest", { method: "POST", headers, body: JSON.stringify(message()) })).status, 200);
    const snapshot = await (await fetch(base + "/snapshot", { headers })).json() as { accounts: unknown[] }; assert.equal(snapshot.accounts.length, 1);
    assert.equal((await fetch(base + "/ingest", { method: "POST", headers, body: "{}" })).status, 400);
    assert.equal((await fetch(base + "/ingest", { method: "POST", headers, body: " ".repeat(40000) })).status, 413);
    assert.equal((await fetch(base + "/collector.user.js")).status, 401);
    const template = await (await fetch(r.installUrl)).text(); assert(template.includes(r.config.serviceId)); assert(!template.includes("/*__GEMINI_DESKTOP_BRIDGE__*/null"));
    const meta = await (await fetch(base + "/meta")).json() as { id: string }; assert.equal(meta.id, r.config.serviceId);
  } finally { await r.close(); rmSync(root, { recursive: true, force: true }); }
});
