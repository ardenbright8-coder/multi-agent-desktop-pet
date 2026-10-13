// Ctrl+Z 撤回（2026-10-13 用户：拖错了、改错了按 Ctrl+Z 退回去）：一步一步退，原样原位置；连着改字算一步；没走 userAction 的不记。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";

function withStore(fn: (store: BookmarkStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-undo-"));
  try {
    fn(new BookmarkStore(join(root, "bookmarks.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rows = (store: BookmarkStore) => store.list().filter((r) => r.assignee === "Claude").map((r) => [r.text, r.bundleId] as [string, string | null]);
const texts = (store: BookmarkStore) => rows(store).map((r) => r[0]);

test("撤回：挪动、搬整捆、删掉、改派一步一步退回原样原位置", () => {
  withStore((store) => {
    const ids: Record<string, string> = {};
    for (const t of ["丁", "丙", "乙", "甲"]) ids[t] = store.add({ text: t, assignee: "Claude" }).id;
    store.createTaskBundle([ids.乙, ids.丙], "捆一");
    const start = JSON.stringify(rows(store));

    store.userAction("挪动一条", () => store.move(ids.甲, ids.丁, "below", null));
    assert.deepEqual(texts(store), ["乙", "丙", "丁", "甲"]);
    const bundle = store.list().find((r) => r.id === ids.乙)!.bundleId!;
    store.userAction("搬整捆", () => store.moveBundle(bundle, "Antigravity", null, "above"));
    store.userAction("删掉一条", () => store.remove(ids.丁));
    store.userAction("改派", () => store.setAssignee(ids.甲, "Pi Agent"));
    assert.deepEqual(texts(store), []);

    assert.equal(store.undo(), "改派");
    assert.equal(store.undo(), "删掉一条");
    assert.equal(store.undo(), "搬整捆");
    assert.deepEqual(texts(store), ["乙", "丙", "丁", "甲"]);
    assert.equal(store.undo(), "挪动一条");
    assert.equal(JSON.stringify(rows(store)), start, "回到最开始：顺序、捆都一样");
    assert.equal(store.undo(), null, "没得撤了");
  });
});

test("撤回：连着改同一条字算一步；新写的一条撤回就没了；改详情能撤；没走 userAction 的（AI、命令行）不记", () => {
  withStore((store) => {
    const a = store.userAction("新写一条", () => store.add({ text: "草", assignee: "Claude" }), (r) => `text:${r.id}`);
    store.userAction("改字", () => store.updateText(a.id, "草稿"), (r) => (r ? `text:${r.id}` : null));
    store.userAction("改字", () => store.updateText(a.id, "草稿完了"), (r) => (r ? `text:${r.id}` : null));
    const h = store.add({ text: "交接单", kind: "handoff", detail: "原来的详情" }); // 命令行写的：不记
    store.userAction("改详情", () => store.updateDetail(h.id, "改过的详情"));
    assert.equal(store.undo(), "改详情");
    assert.equal(store.list().find((r) => r.id === h.id)!.detail, "原来的详情");
    assert.equal(store.undo(), "新写一条", "新写＋连着改字合成一步");
    assert.equal(store.list().some((r) => r.id === a.id), false);
    assert.equal(store.list().some((r) => r.id === h.id), true, "命令行写的那条不受撤回影响");
    assert.equal(store.undo(), null);
  });
});

test("改详情：清空就是不要详情，条目留着", () => {
  withStore((store) => {
    const h = store.add({ text: "交接单", kind: "handoff", detail: "六块" });
    assert.equal(store.updateDetail(h.id, "  ")!.detail, null);
    assert.equal(store.updateDetail("没有这条", "x"), null);
  });
});
