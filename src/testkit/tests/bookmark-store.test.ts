import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import { attachmentsRoot } from "../../shared/paths";

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
    assert.deepEqual(list[0].attachments, []);
    assert.equal(list[1].assignee, null);
    assert.throws(() => store.add({ text: "   " }), /内容不能为空/);
    assert.equal(store.count(), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark insertBeside puts a note above or below the anchor", () => {
  const { store, root } = tempStore();
  try {
    const first = store.add({ text: "第一条" });
    const third = store.add({ text: "第三条" });
    const below = store.insertBeside(third.id, "below", { text: "插在下面" });
    const above = store.insertBeside(third.id, "above", { text: "插在上面" });
    assert.deepEqual(store.list().map((record) => record.text), ["插在上面", "第三条", "插在下面", "第一条"]);
    assert.equal(below.id !== above.id, true);
    assert.equal(store.insertBeside("missing", "above", { text: "没锚点就放最前" }).text, "没锚点就放最前");
    assert.equal(store.list()[0].text, "没锚点就放最前");
    assert.throws(() => store.insertBeside(first.id, "above", { text: "  " }), /内容不能为空/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark move puts one note above or below another and keeps it after reload", () => {
  const { store, path, root } = tempStore();
  try {
    const first = store.add({ text: "第一条" });
    const second = store.add({ text: "第二条" });
    const third = store.add({ text: "第三条" });
    store.move(first.id, third.id, "above");
    assert.deepEqual(store.list().map((record) => record.text), ["第一条", "第三条", "第二条"]);
    store.move(second.id, first.id, "below");
    assert.deepEqual(store.list().map((record) => record.text), ["第一条", "第二条", "第三条"]);
    assert.equal(store.move(first.id, first.id, "below")?.text, "第一条");
    const reloaded = new BookmarkStore(path);
    assert.deepEqual(reloaded.list().map((record) => record.text), ["第一条", "第二条", "第三条"]);
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

test("bookmark handoff detail/kind 落库（交接单：标题+详情+显眼类型）", () => {
  const { store, root } = tempStore();
  try {
    const record = store.add({
      text: "书签台分页改完了，交给你验收",
      kind: "handoff",
      detail: "做了：两页签切换+角标。交出来：renderer 三件套改动，测试全绿。下一步：手机端同款分页待拍板。",
    });
    assert.equal(record.kind, "handoff");
    assert.ok(record.detail?.includes("两页签"));
    // 普通条目 kind 回落 note。
    const plain = store.add({ text: "普通一条" });
    assert.equal(plain.kind, "note");
    assert.equal(plain.detail, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark store 旧库没有 kind/detail 字段照常读（回落 note/无详情）", () => {
  const { store, path, root } = tempStore();
  try {
    const legacy = { id: "b-legacy", text: "旧版记录", url: null, assignee: "Claude", dedupeKey: null, createdAt: "2026-09-09T00:00:00.000Z" };
    writeFileSync(path, `${JSON.stringify([legacy])}\n`, "utf8");
    const list = new BookmarkStore(path).list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.kind, "note");
    assert.equal(list[0]?.detail, null);
    assert.deepEqual(list[0]?.attachments, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark attachments 字段创建时传入、落盘、读回原样", () => {
  const { store, path, root } = tempStore();
  try {
    const record = store.add({ text: "带图的条目", attachments: ["shot.png", "C:\\pics\\note.jpg"] });
    assert.deepEqual(record.attachments, ["shot.png", "note.jpg"]);
    const reloaded = new BookmarkStore(path).list();
    assert.deepEqual(reloaded[0]?.attachments, ["shot.png", "note.jpg"]);
    assert.match(readFileSync(path, "utf8"), /"shot.png"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bookmark addAttachment 拷贝进 attachments 并写字段", () => {
  const { store, path, root } = tempStore();
  const prev = process.env.AGENT_PET_HUB_HOME;
  process.env.AGENT_PET_HUB_HOME = root;
  try {
    const record = store.add({ text: "要贴图" });
    const src = join(root, "src.png");
    writeFileSync(src, "fake-png-bytes");
    const updated = store.addAttachment(record.id, src);
    assert.ok(updated);
    assert.equal(updated.attachments.length, 1);
    const storedName = updated.attachments[0];
    assert.equal(storedName, `${record.id}-src.png`);
    const dest = join(attachmentsRoot(), storedName);
    assert.ok(existsSync(dest));
    assert.equal(readFileSync(dest, "utf8"), "fake-png-bytes");
    const reloaded = new BookmarkStore(path).list();
    assert.deepEqual(reloaded[0]?.attachments, [storedName]);
    assert.equal(store.addAttachment("no-such-id", src), null);
    assert.throws(() => store.addAttachment(record.id, join(root, "missing.png")), /贴图源文件不存在/);
  } finally {
    if (prev === undefined) delete process.env.AGENT_PET_HUB_HOME;
    else process.env.AGENT_PET_HUB_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
