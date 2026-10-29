// 接活自动标单测（2026-10-29 用户：AI 老忘了标在干，让程序自己判）：
// 看板看见条目被交出去（拖出窗口、复制单独文件路径）先标「已交出」，哪个窗口头一个拿自己的名字碰它，就换成那个窗口名。
// 期望答案都在这里手写，不拿被测函数算。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore, HANDED_OUT } from "../../bookmark/store";
import { formatItemFile } from "../../bookmark/item-files";

function withStore(fn: (store: BookmarkStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bm-handout-"));
  try {
    fn(new BookmarkStore(join(root, "bookmarks.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("handOut：没人领的标「已交出」；已经有窗口在干的、交过报告的不动；返回标了几条", () => {
  withStore((store) => {
    const a = store.add({ text: "甲", assignee: "Claude" }).id;
    const b = store.add({ text: "乙", assignee: "Claude" }).id;
    const c = store.add({ text: "丙", assignee: "Claude" }).id;
    store.claimNext(b, "Claude-1");
    store.claimNext(c, "Claude-2");
    store.report(c, "Claude-2", "做完了");
    assert.equal(store.handOut([a, b, c]), 1);
    const by = (id: string) => store.list().find((r) => r.id === id)?.claimedBy;
    assert.equal(by(a), "已交出");
    assert.equal(by(b), "Claude-1", "别人在干的不抢");
    assert.equal(by(c), null, "交过报告的不再标");
    assert.equal(store.handOut([a]), 0, "已经交出的不重复标");
  });
});

test("已交出的：next 领它就换成窗口名；别的窗口碰 log / 清单 / done 也直接接走", () => {
  withStore((store) => {
    const a = store.add({ text: "甲", assignee: "Claude" }).id;
    const b = store.add({ text: "乙", assignee: "Pi Agent" }).id;
    const c = store.add({ text: "丙", assignee: "Claude" }).id;
    store.handOut([a, b, c]);
    const got = store.claimNext(a, "Claude-7");
    assert.equal(got.record?.id, a);
    assert.equal(got.record?.claimedBy, "Claude-7");
    assert.deepEqual(got.busy, [], "已交出不算别人在干");
    store.appendProgress(b, "Pi-甲", "开始改");
    assert.equal(store.list().find((r) => r.id === b)?.claimedBy, "Pi-甲");
    assert.throws(() => store.appendProgress(b, "Pi-乙", "我也来"), /不是你领的/, "接走以后别的窗口进不来");
    store.done(c, "Claude-8", "可以");
    assert.equal(store.list().some((r) => r.id === c), false);
  });
});

test("已交出的：看板上用户勾一项不算接走；AI 勾一项接走", () => {
  withStore((store) => {
    const a = store.add({ text: "甲", assignee: "Claude" }).id;
    store.handOut([a]);
    store.setChecklist(a, [{ no: "1", text: "一", done: false, by: null, at: null }, { no: "2", text: "二", done: false, by: null, at: null }], "Claude-3");
    assert.equal(store.list().find((r) => r.id === a)?.claimedBy, "Claude-3", "交清单就是接");
    store.release(a);
    store.handOut([a]);
    store.tick(a, "1", "用户");
    assert.equal(store.list().find((r) => r.id === a)?.claimedBy, HANDED_OUT);
  });
});

test("撤回账存在硬盘上：重开看板（新的 store 读同一个文件）以后 Ctrl+Z 照样退「交给 AI」那一步", () => {
  const root = mkdtempSync(join(tmpdir(), "bm-handout-undo-"));
  try {
    const path = join(root, "bookmarks.json");
    const first = new BookmarkStore(path);
    const a = first.add({ text: "甲", assignee: "Claude" }).id;
    first.userAction("交给 AI", () => first.handOut([a]));
    const again = new BookmarkStore(path);
    assert.equal(again.list().find((r) => r.id === a)?.claimedBy, HANDED_OUT);
    assert.equal(again.undo(), "交给 AI");
    assert.equal(again.list().find((r) => r.id === a)?.claimedBy, null);
    assert.equal(new BookmarkStore(path).undo(), null, "退过的那步不会再来一次");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("单独文件：没人领或已交出的写一句「先敲 next 接下」，有窗口在干的不写", () => {
  withStore((store) => {
    const a = store.add({ text: "甲", assignee: "Claude" }).id;
    const free = () => formatItemFile(store.list().find((r) => r.id === a)!, { group: "Claude" });
    assert.match(free(), new RegExp(`看板 next ${a} --by`));
    store.handOut([a]);
    assert.match(free(), /已交给 AI，还没窗口认领/);
    assert.match(free(), /看板 next/);
    store.claimNext(a, "Claude-1");
    assert.doesNotMatch(free(), /看板 next/);
  });
});
