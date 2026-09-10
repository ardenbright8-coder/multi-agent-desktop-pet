import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";

function tempStore(): { store: BookmarkStore; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-bookmark-"));
  const path = join(root, "bookmarks.json");
  return { store: new BookmarkStore(path), path, root };
}

test("bookmark add/list is newest first and rejects empty text", () => {
  const { store, root } = tempStore();
  try {
    const first = store.add({ text: "第一条" });
    const second = store.add({ text: "看看这个", url: "https://example.com/a" });
    const list = store.list();
    assert.deepEqual(list.map((record) => record.id), [second.id, first.id]);
    assert.equal(list[0].url, "https://example.com/a");
    assert.equal(list[1].assignee, null);
    assert.throws(() => store.add({ text: "   " }), /内容不能为空/);
    assert.equal(store.count(), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark dedupeKey swallows duplicate deliveries (手机离线重发不重复入库)", () => {
  const { store, root } = tempStore();
  try {
    const first = store.add({ text: "早上发的想法", dedupeKey: "phone-msg-42" });
    const again = store.add({ text: "早上发的想法", dedupeKey: "phone-msg-42" });
    assert.equal(again.id, first.id);
    assert.equal(store.count(), 1);
    const other = store.add({ text: "另一条", dedupeKey: "phone-msg-43" });
    assert.notEqual(other.id, first.id);
    assert.equal(store.count(), 2);
    // 不带 key 的照常各记一条。
    store.add({ text: "没有 key 的" });
    assert.equal(store.count(), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark remove and setAssignee update the store and persist", () => {
  const { store, path, root } = tempStore();
  try {
    const record = store.add({ text: "跨窗拖动第一阶", assignee: "Claude" });
    assert.equal(store.setAssignee(record.id, "Grok")?.assignee, "Grok");
    assert.equal(store.setAssignee(record.id, null)?.assignee, null);
    assert.equal(store.setAssignee("no-such-id", "Pi"), null);
    assert.equal(store.remove(record.id), true);
    assert.equal(store.remove(record.id), false);
    const reloaded = new BookmarkStore(path).list();
    assert.equal(reloaded.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark records survive a store reload (原子写落盘)", () => {
  const { store, path, root } = tempStore();
  try {
    store.add({ text: "重启后还在", assignee: "Pi" });
    const reloaded = new BookmarkStore(path);
    const list = reloaded.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].text, "重启后还在");
    assert.equal(list[0].assignee, "Pi");
    assert.match(readFileSync(path, "utf8"), /"text": "重启后还在"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark store quarantines a corrupted file and starts fresh", () => {
  const { store, path, root } = tempStore();
  try {
    writeFileSync(path, "{oops 不是合法 JSON", "utf8");
    assert.equal(store.list().length, 0);
    const quarantined = readdirSync(root).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
    // 坏档挪走后照常写新数据。
    store.add({ text: "坏档之后的第一条" });
    const reloaded = new BookmarkStore(path);
    assert.equal(reloaded.list().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark store ignores malformed entries but keeps the good ones", () => {
  const { store, path, root } = tempStore();
  try {
    const good = { id: "b-good", text: "好记录", url: null, assignee: null, dedupeKey: null, createdAt: "2026-09-09T00:00:00.000Z" };
    writeFileSync(path, `${JSON.stringify([good, { nope: true }, "垃圾", null])}\n`, "utf8");
    const list = new BookmarkStore(path).list();
    assert.deepEqual(list.map((record) => record.id), ["b-good"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
