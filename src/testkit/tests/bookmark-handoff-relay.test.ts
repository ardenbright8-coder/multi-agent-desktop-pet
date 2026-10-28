// 交接单接力单测（2026-10-28 用户：交接单越堆越多，干完了单子还挂着，要我一条条删）。
// 管哪几条：done 时一起删；新单顶掉写单窗口手里那张；边干边记一句。期望答案手写，不拿被测函数算。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import { handleCliRequest, parseCliArgs, type CliStoreAdapter } from "../../bookmark/cli-server";

function withStore(fn: (store: BookmarkStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-relay-"));
  try {
    fn(new BookmarkStore(join(root, "bookmarks.json")));
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
    done: (id, by, ok) => store.done(id, by, ok),
    heldHandoff: (by) => store.list().find((r) => r.kind === "handoff" && r.claimedBy === by),
    supersede: (a, b) => store.supersede(a, b),
    appendProgress: (id, by, text) => store.appendProgress(id, by, text),
    boardNames: () => ({ agents: ["Claude"], titles: {}, bundleNames: {} }),
  } as CliStoreAdapter;
}

const post = (store: BookmarkStore, path: string, body: unknown) =>
  handleCliRequest("POST", path, body, "Bearer t", { token: "t", store: adapter(store) });

test("命令行：handoff 认 --by 和 --closes；log 要 --by 和 --text", () => {
  const a = parseCliArgs(["handoff", "标题", "--by", "Claude-3", "--closes", "01,08"]);
  assert.equal(a.by, "Claude-3");
  assert.equal(a.closes, "01,08");
  const l = parseCliArgs(["log", "abc", "--by", "Claude-3", "--text", "改好了", "菜单"]);
  assert.equal(l.command, "log");
  assert.equal(l.text, "改好了 菜单");
  assert.throws(() => parseCliArgs(["log", "abc", "--by", "Claude-3"]), /--text/);
});

test("交接单管着的条目：号码换成 id 挂上，done 时一起删；别的窗口正领着的不删", () =>
  withStore((store) => {
    const 甲 = store.add({ text: "甲", assignee: "Claude" }).id;
    const 乙 = store.add({ text: "乙", assignee: "Claude" }).id;
    store.claimNext(甲, "别的窗口");
    const res = post(store, "/handoff", { text: "接着修", closes: "01,02" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const card = store.list().find((r) => r.kind === "handoff")!;
    assert.deepEqual([...(card.links ?? [])].sort(), [甲, 乙].sort(), "01、02 号换成了甲乙的 id");
    store.claimNext(card.id, "Claude-9");
    store.done(card.id, "Claude-9", "可以");
    assert.deepEqual(store.list().map((r) => r.text), ["甲"], "乙跟着删了，甲别人领着留下");
    assert.equal(post(store, "/handoff", { text: "x", closes: "99" }).status, 400, "对不上的号码整张不写");
  }));

test("接力：领着交接单的窗口写新单，旧单删掉、管的条目并过来、新单站旧单的位置", () =>
  withStore((store) => {
    const 丙 = store.add({ text: "丙", assignee: "Claude" }).id;
    const old = store.add({ text: "旧单", kind: "handoff", links: [丙] }).id;
    store.add({ text: "别的单", kind: "handoff" });
    store.claimNext(old, "Claude-3");
    const res = post(store, "/handoff", { text: "新单", by: "Claude-3" });
    assert.equal(res.status, 200);
    const cards = store.list().filter((r) => r.kind === "handoff").map((r) => r.text);
    assert.deepEqual(cards, ["别的单", "新单"], "旧单没了，新单在旧单原位置");
    assert.deepEqual(store.list().find((r) => r.text === "新单")!.links, [丙]);
    post(store, "/handoff", { text: "没领单的窗口写的", by: "Claude-8" });
    assert.equal(store.list().filter((r) => r.kind === "handoff").length, 3, "手里没领交接单就只是新写一张");
  }));

test("边干边记：领着的窗口追加一句进度，不是它领的报错", () =>
  withStore((store) => {
    const id = store.add({ text: "单子", kind: "handoff", detail: "原来的详情" }).id;
    store.claimNext(id, "Claude-3");
    assert.equal(post(store, "/log", { id, by: "Claude-3", text: "改好了菜单" }).status, 200);
    assert.match(store.list()[0].detail ?? "", /^原来的详情\n【进度 \d+-\d+ \d\d:\d\d】改好了菜单$/);
    assert.equal(post(store, "/log", { id, by: "Claude-5", text: "乱记" }).status, 400);
  }));
