// 捆一捆 + AI 领活单测（2026-09-24 用户拍板：一捆交一个窗口、一条一条领、领了别人抢不走、用户说可以才删）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";

function withStore(fn: (store: BookmarkStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-bundle-"));
  try {
    fn(new BookmarkStore(join(root, "bookmarks.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 按看板显示顺序排好的 Claude 组：[文字, 捆号] */
function claudeRows(store: BookmarkStore): [string, string | null][] {
  return store.list().filter((r) => r.assignee === "Claude").map((r) => [r.text, r.bundleId]);
}

/** 建一个 Claude 组，看板上从上到下是 甲 乙 丙 丁。 */
function seed(store: BookmarkStore): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const text of ["丁", "丙", "乙", "甲"]) ids[text] = store.add({ text, assignee: "Claude" }).id;
  return ids;
}

test("捆：拖到别条正中间就捆上，挪到那一捆的最后；旧库没有这几个字段读进来是 null", () => {
  withStore((store) => {
    const ids = seed(store);
    assert.equal(store.list()[0].bundleId, null);
    assert.equal(store.list()[0].claimedBy, null);
    store.bundleWith(ids.丁, ids.甲);
    const rows = claudeRows(store);
    assert.deepEqual(rows.map((r) => r[0]), ["甲", "丁", "乙", "丙"]);
    assert.ok(rows[0][1] && rows[0][1] === rows[1][1]);
    assert.equal(rows[2][1], null);
    store.bundleWith(ids.丙, ids.甲);
    assert.deepEqual(claudeRows(store).map((r) => r[0]), ["甲", "丁", "丙", "乙"]);
    assert.equal(new Set(claudeRows(store).slice(0, 3).map((r) => r[1])).size, 1);
  });
});

test("捆：只能捆同一组的", () => {
  withStore((store) => {
    const a = store.add({ text: "给 Claude", assignee: "Claude" });
    const b = store.add({ text: "给 Hermes", assignee: "Hermes" });
    assert.throws(() => store.bundleWith(b.id, a.id), /同一组/);
  });
});

test("挪动：插进捆中间＝进捆；捆里的在捆边上挪＝还在捆里；挪出去＝离开；只剩一条的捆自动散", () => {
  withStore((store) => {
    const ids = seed(store);
    store.bundleWith(ids.乙, ids.甲); // 捆：甲 乙 | 丙 丁
    store.bundleWith(ids.丙, ids.甲); // 捆：甲 乙 丙 | 丁
    const bundle = store.list().find((r) => r.id === ids.甲)!.bundleId;
    store.move(ids.丁, ids.乙, "below"); // 插在 乙 和 丙 中间
    assert.equal(store.list().find((r) => r.id === ids.丁)!.bundleId, bundle);
    store.move(ids.丙, ids.甲, "above"); // 捆里的挪到捆的最上面：还在捆里
    assert.equal(store.list().find((r) => r.id === ids.丙)!.bundleId, bundle);
    const other = store.add({ text: "戊", assignee: "Claude" }); // 在最上面，捆外
    store.move(ids.甲, other.id, "above"); // 挪到捆外面、不挨着捆
    assert.equal(store.list().find((r) => r.id === ids.甲)!.bundleId, null);
    store.move(ids.丁, other.id, "above");
    store.move(ids.丙, other.id, "above"); // 捆里只剩 乙
    assert.equal(store.list().find((r) => r.id === ids.乙)!.bundleId, null);
  });
});

test("改派到别的组：自动离开原来的捆、领活标记清掉", () => {
  withStore((store) => {
    const ids = seed(store);
    store.bundleWith(ids.乙, ids.甲);
    store.bundleWith(ids.丙, ids.甲);
    store.claimNext(ids.甲, "Claude-1");
    store.setAssignee(ids.甲, "Hermes");
    const moved = store.list().find((r) => r.id === ids.甲)!;
    assert.equal(moved.bundleId, null);
    assert.equal(moved.claimedBy, null);
  });
});

test("领活：一捆一条一条领；同一个窗口没干完再领还是那条；别的窗口抢不走", () => {
  withStore((store) => {
    const ids = seed(store);
    store.bundleWith(ids.乙, ids.甲);
    store.bundleWith(ids.丙, ids.甲);
    const bundle = store.list().find((r) => r.id === ids.甲)!.bundleId!;
    const first = store.claimNext(bundle, "Claude-1");
    assert.equal(first.record?.text, "甲");
    assert.equal(first.position, 1);
    assert.equal(first.total, 3);
    assert.equal(store.claimNext(bundle, "Claude-1").record?.text, "甲");
    const second = store.claimNext(bundle, "Claude-2");
    assert.equal(second.record?.text, "乙");
    assert.equal(store.list().find((r) => r.id === ids.甲)!.claimedBy, "Claude-1");
  });
});

test("干完：不是自己领的删不了；没带用户原话删不了；带了才删，删完领下一条", () => {
  withStore((store) => {
    const ids = seed(store);
    store.bundleWith(ids.乙, ids.甲);
    const bundle = store.list().find((r) => r.id === ids.甲)!.bundleId!;
    store.claimNext(bundle, "Claude-1");
    assert.throws(() => store.done(ids.甲, "Claude-2", "可以"), /不是你领的/);
    assert.throws(() => store.done(ids.甲, "Claude-1", "  "), /用户/);
    store.done(ids.甲, "Claude-1", "可以，没问题");
    assert.equal(store.list().some((r) => r.id === ids.甲), false);
    assert.equal(store.claimNext(bundle, "Claude-1").record?.text, "乙");
  });
});

test("单条也能领；领完了再领告诉你没活了；放回去以后别人能领", () => {
  withStore((store) => {
    const ids = seed(store);
    assert.equal(store.claimNext(ids.丁, "Claude-1").record?.text, "丁");
    const again = store.claimNext(ids.丁, "Claude-2");
    assert.equal(again.record, null);
    assert.deepEqual(again.busy, ["Claude-1"]);
    store.release(ids.丁);
    assert.equal(store.claimNext(ids.丁, "Claude-2").record?.text, "丁");
    assert.throws(() => store.claimNext("b-没有这捆", "Claude-1"), /找不到/);
  });
});
