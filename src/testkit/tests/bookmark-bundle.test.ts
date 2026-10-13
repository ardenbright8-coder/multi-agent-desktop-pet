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

// 2026-10-13 拖动改版：界面说清了「进哪捆 / 单独放」，store 照办（变绿＝合并，不绿＝单独放）。
test("拖动说清了去向：拖到捆底下边缘＝拆出来；夹在两捆中间＝单独放；进别的捆插在指定位置；进捆没挨着就挪到捆尾", () => {
  withStore((store) => {
    const ids = seed(store);
    const extra = ["戊", "己"].reverse().map((t) => store.add({ text: t, assignee: "Claude" }).id);
    // 顺序：己 戊 甲 乙 丙 丁 → 捆一：甲 乙 丙；捆二：己 戊
    store.createTaskBundle([ids.甲, ids.乙, ids.丙], "捆一");
    store.createTaskBundle([extra[1], extra[0]], "捆二");
    const one = store.list().find((r) => r.id === ids.甲)!.bundleId!;
    const two = store.list().find((r) => r.id === extra[0])!.bundleId!;
    const where = (id: string) => store.list().find((r) => r.id === id)!.bundleId;

    // 甲拖到捆一最后一条（丙）下面、不绿 → 拆出来
    store.move(ids.甲, ids.丙, "below", null);
    assert.equal(where(ids.甲), null);
    assert.equal(where(ids.乙), one, "捆一还剩乙丙");
    assert.equal(store.list().find((r) => r.id === ids.甲)!.userPinned, true);

    // 甲拖进捆二、插在己上面（整捆绿）→ 进捆二、就在那个位置
    store.move(ids.甲, extra[1], "above", two);
    assert.equal(where(ids.甲), two);
    const order = claudeRows(store).map((r) => r[0]);
    assert.ok(order.indexOf("甲") < order.indexOf("己"), "插在指定位置，不是一律塞到最后");

    // 说要进捆一、锚点却在捆外（丁下面）→ 挪到捆一最后，捆不被插断
    store.move(ids.甲, ids.丁, "below", one);
    const rows = claudeRows(store);
    const i = rows.findIndex((r) => r[0] === "甲");
    assert.equal(rows[i][1], one);
    assert.equal(rows[i - 1][1], one, "紧挨着捆一");

    // 说单独放、位置却夹在捆一两条中间 → 挪到捆一后面，单独放
    store.move(ids.甲, ids.乙, "below", null);
    const rows2 = claudeRows(store);
    const j = rows2.findIndex((r) => r[0] === "甲");
    assert.equal(rows2[j][1], null);
    assert.notEqual(rows2[j + 1]?.[1], one, "没把捆一插断");
    assert.equal(rows2[j - 1][1], one);

    // 捆一只剩两条时拆出一条：剩下那条自己散开
    store.move(ids.乙, ids.丁, "below", null);
    assert.equal(where(ids.丙), null);
  });
});

// 2026-10-13 跨组一步到位、复制一条（Ctrl+C 再放下）
test("跨组一步到位：改派＋放到锚点旁边＋进捆；复制一条：紧跟原条、领活报告捆都不带", () => {
  withStore((store) => {
    const ids = seed(store);
    const other = store.add({ text: "戊", assignee: "Antigravity" }).id;
    store.createTaskBundle([ids.乙, ids.丙], "捆一");
    const one = store.list().find((r) => r.id === ids.乙)!.bundleId!;
    // 戊 从 Antigravity 拖进 Claude 的捆一、插在乙下面
    const moved = store.relocate(other, "Claude", ids.乙, "below", one)!;
    assert.equal(moved.assignee, "Claude");
    assert.equal(moved.bundleId, one);
    assert.deepEqual(claudeRows(store).map((r) => r[0]), ["甲", "乙", "戊", "丙", "丁"]);
    assert.equal(moved.sortedAt, null, "换组＝新组里的新条目，AI 会重读");
    // 甲 拖进空的 Antigravity 组（没有锚点）：改派过去就行
    assert.equal(store.relocate(ids.甲, "Antigravity", null, "above")!.assignee, "Antigravity");

    store.claimNext(ids.丁, "窗口1");
    const copy = store.duplicate(ids.丁)!;
    assert.notEqual(copy.id, ids.丁);
    assert.equal(copy.text, "丁");
    assert.equal(copy.claimedBy, null, "领活不带");
    assert.equal(copy.bundleId, null);
    const rows = claudeRows(store).map((r) => r[0]);
    assert.equal(rows.lastIndexOf("丁"), rows.indexOf("丁") + 1, "紧跟在原条后面");
    assert.equal(store.duplicate("没有这条"), null);
  });
});
