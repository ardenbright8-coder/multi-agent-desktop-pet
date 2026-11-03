// 交接单收尾单测（2026-11-03 用户：交接单堆成一堆、不会自己消失；先把洞补上）。
// 掉线接手、同一件事别写两张、挂起、久没动、收单把关。期望答案手写，不拿被测函数算。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import { handleCliRequest, parseCliArgs, type CliStoreAdapter } from "../../bookmark/cli-server";
import { formatBrief, indexBoard } from "../../bookmark/board-index";
import { idleDays, similarHandoffs, titleSimilarity } from "../../bookmark/handoff-hygiene";
import { lookupWindow } from "../../bookmark/agent-watch";
import { recordWrittenSince } from "../../bookmark/issue-guard";

function withStore(fn: (store: BookmarkStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bm-hygiene-"));
  try {
    fn(new BookmarkStore(join(root, "bookmarks.json")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function adapter(store: BookmarkStore): CliStoreAdapter {
  return {
    add: (input) => store.add(input),
    list: () => store.list(),
    remove: (id) => store.remove(id),
    claimNext: (target, by) => store.claimNext(target, by),
    heldHandoff: (by) => store.list().find((r) => r.kind === "handoff" && r.claimedBy === by),
    supersede: (a, b) => store.supersede(a, b),
    hold: (id, by, why) => store.hold(id, by, why),
    unhold: (id) => store.unhold(id),
    boardNames: () => ({ agents: ["Claude"], titles: {}, bundleNames: {} }),
  } as CliStoreAdapter;
}

const post = (store: BookmarkStore, path: string, body: unknown) =>
  handleCliRequest("POST", path, body, "Bearer t", { token: "t", store: adapter(store) });

/** 把一条的时间往回拨（list 给的是同一个对象）。 */
function age(store: BookmarkStore, id: string, ms: number): void {
  const r = store.list().find((x) => x.id === id)!;
  const back = (v: string | null | undefined) => (v ? new Date(Date.parse(v) - ms).toISOString() : v);
  r.createdAt = back(r.createdAt)!;
  r.claimedAt = back(r.claimedAt) ?? null;
  if (r.touchedAt) r.touchedAt = back(r.touchedAt)!;
}

const HOUR = 3_600_000;

test("像不像：看板上真有的三张「燊一修跑关系网更新」两两都认得出，不相干的认不出", () => {
  const a = "【给燊一修】改动连带检查第二轮（关联写法、表版本 9）：燊一修那边先跑一次 关系网 更新，再跑真库回归对一下";
  const b = "【给燊一修】改动连带检查、建skill 根这边改了：燊一修那边先跑一次 关系网 更新（表版本变了，约 6 分钟），再跑真库回归对一下";
  const c = "【给燊一修】改动连带检查：根这边修完漏算和隔离（提交 2fa557a），燊一修这边跑 更新 重建表、跑小题和真库回归验一下";
  const x = "Windows默认装F盘设置：微软商店的新应用要默认存到F盘（文档音乐照片视频仍留D盘）";
  assert.ok(titleSimilarity(a, b) >= 0.28);
  assert.ok(titleSimilarity(b, c) >= 0.28);
  assert.ok(titleSimilarity(a, x) < 0.28);
  const hits = similarHandoffs(c, [{ id: "1", text: a, kind: "handoff" }, { id: "2", text: x, kind: "handoff" }, { id: "3", text: b, kind: "note" }]);
  assert.deepEqual(hits.map((h) => h.record.id), ["1"], "只比交接单，普通条目不算");
});

test("写交接单：跟已有的像就拦下（409）并指出那张；加 --new 照样写", () =>
  withStore((store) => {
    const first = post(store, "/handoff", { text: "燊一修那边先跑一次关系网更新，再跑真库回归" });
    assert.equal(first.status, 200);
    const dup = post(store, "/handoff", { text: "燊一修这边跑关系网更新、跑真库回归验一下" });
    assert.equal(dup.status, 409);
    assert.match(String((dup.body as { error: string }).error), /第 1 条.*log/);
    assert.equal(store.list().length, 1, "拦下的没写进去");
    assert.equal(post(store, "/handoff", { text: "燊一修这边跑关系网更新、跑真库回归验一下", force: true }).status, 200);
    assert.equal(store.list().length, 2);
    assert.equal(parseCliArgs(["handoff", "标题", "--new"]).force, true);
  }));

test("掉线接手：领着的窗口一小时没动静，别的窗口 next 直接接走，原窗口最后说的话记进进度", () =>
  withStore((store) => {
    const id = store.add({ text: "修看板", kind: "handoff" }).id;
    store.claimNext(id, "Claude-d981");
    store.setWindowLookup((name) => (name === "Claude-d981" ? { lastAt: Date.now() - 3 * HOUR, lastWords: ["侧边栏按钮做完了"] } : null));
    age(store, id, 3 * HOUR);
    const got = store.claimNext(id, "Claude-新窗口");
    assert.equal(got.record?.claimedBy, "Claude-新窗口");
    const said = store.list()[0].progress?.join("\n") ?? "";
    assert.match(said, /系统自动接手：原窗口 Claude-d981 已 3 小时没动静/);
    assert.match(said, /侧边栏按钮做完了/);
  }));

test("掉线接手：窗口还在写会话记录、或刚碰过单子，就不抢", () =>
  withStore((store) => {
    const id = store.add({ text: "修看板", kind: "handoff" }).id;
    store.claimNext(id, "Claude-aaaa");
    age(store, id, 5 * HOUR);
    store.setWindowLookup(() => ({ lastAt: Date.now() - 60_000, lastWords: [] }));
    assert.equal(store.claimNext(id, "Claude-bbbb").record, null, "会话记录一分钟前还在写");
    store.setWindowLookup(null);
    store.appendProgress(id, "Claude-aaaa", "还在干");
    assert.equal(store.claimNext(id, "Claude-bbbb").record, null, "刚 log 过");
    assert.equal(store.list()[0].claimedBy, "Claude-aaaa");
  }));

test("挂起：按组领跳过它；别的窗口领着的挂不了；点名 next 自动取消挂起；读盘还在", () =>
  withStore((store, root) => {
    const a = store.add({ text: "先不做的", assignee: "Claude" }).id;
    const b = store.add({ text: "要做的", assignee: "Claude" }).id;
    store.hold(a, "用户", "他说先不做，等他说做再做");
    assert.equal(store.claimInGroup("Claude", "Claude-1").record?.id, b, "挂起的不发");
    assert.throws(() => store.hold(b, "Claude-2", "x"), /Claude-1 领着/);
    assert.throws(() => store.hold(a, "用户", "  "), /原因/);
    const again = new BookmarkStore(join(root, "bookmarks.json"));
    assert.equal(again.list().find((r) => r.id === a)?.hold?.why, "他说先不做，等他说做再做");
    const got = store.claimNext(a, "Claude-3");
    assert.equal(got.record?.id, a);
    assert.equal(store.list().find((r) => r.id === a)?.hold, undefined);
  }));

test("挂起的交接单排到专区最底下，list 标「挂起」和原因；久没人碰的标天数", () =>
  withStore((store) => {
    const old = store.add({ text: "老单子", kind: "handoff" }).id;
    const held = store.add({ text: "挂着的", kind: "handoff" }).id;
    store.add({ text: "新单子", kind: "handoff" });
    store.hold(held, "用户", "等他说");
    age(store, old, 9 * 24 * HOUR);
    const rows = indexBoard(store.list(), ["Claude"]).flatMap((g) => g.rows);
    assert.equal(rows[rows.length - 1].record.id, held);
    const text = formatBrief(indexBoard(store.list(), ["Claude"]), { titles: {}, bundleNames: {} });
    assert.match(text, /挂着的\s+⏸ 挂起（等他说）/);
    assert.match(text, /老单子\s+🕸 9 天没人碰/);
    assert.equal(idleDays(store.list().find((r) => r.id === held)!), 0, "挂起的不算久没动");
  }));

test("命令行挂起：认号码，缺原因报错；取消挂起", () =>
  withStore((store) => {
    store.add({ text: "一张", kind: "handoff" });
    assert.equal(parseCliArgs(["挂起", "1", "--why", "先不做", "等通知"]).text, "先不做 等通知");
    assert.throws(() => parseCliArgs(["挂起", "1"]), /--why/);
    assert.equal(post(store, "/hold", { id: "1", by: "", text: "先不做" }).status, 200);
    assert.ok(store.list()[0].hold);
    assert.equal(post(store, "/unhold", { id: "1" }).status, 200);
    assert.equal(store.list()[0].hold, undefined);
  }));

test("收单把关：拦下时最后一项不算勾上、单子还在；他在看板上亲手勾不拦", () =>
  withStore((store) => {
    const id = store.add({ text: "修看板", kind: "handoff" }).id;
    store.claimNext(id, "Claude-1");
    store.setChecklist(id, [{ no: "1", text: "改代码", done: false }, { no: "2", text: "写问题账", done: false }] as never, "Claude-1");
    store.setCloseGuard(() => "先别收单：问题账没写");
    store.tick(id, "1", "Claude-1");
    assert.throws(() => store.tick(id, "2", "Claude-1"), /问题账没写/);
    const card = store.list().find((r) => r.id === id);
    assert.ok(card, "单子还在");
    assert.equal(card!.checklist!.find((i) => i.no === "2")!.done, false);
    const res = store.tick(id, "2", "用户");
    assert.equal(res.closed, true);
  }));

test("收单把关的检查：问题账夹里有这期间改过的 md 才算写了", () => {
  const root = mkdtempSync(join(tmpdir(), "bm-issue-"));
  try {
    const dir = join(root, "维修（排障）", "03_某个问题");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "解决方案.md");
    writeFileSync(f, "x");
    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(f, old, old);
    assert.equal(recordWrittenSince([join(root, "维修（排障）")], Date.now() - HOUR), false);
    writeFileSync(f, "y");
    assert.equal(recordWrittenSince([join(root, "维修（排障）")], Date.now() - HOUR), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("认窗口：Claude-末4位 找到会话记录、取 AI 最后两句；Claude-1 这种认不出", () => {
  const home = mkdtempSync(join(tmpdir(), "bm-home-"));
  try {
    const dir = join(home, ".claude", "projects", "C--x");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "user", message: { role: "user", content: "接第 3 条" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一句" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "侧边栏\n按钮做完了" }] } },
    ];
    writeFileSync(join(dir, "aaaa-bbbb-d981.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const seen = lookupWindow(home, "Claude-d981");
    assert.ok(seen);
    assert.deepEqual(seen!.lastWords, ["第一句", "侧边栏 按钮做完了"]);
    assert.equal(lookupWindow(home, "Claude-1"), null);
    assert.equal(lookupWindow(home, "Claude-ffff"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
