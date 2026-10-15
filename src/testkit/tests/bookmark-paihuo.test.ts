// 派活单 + 一条一份小文件（2026-10-15 设定23、24）：批号、一键启动选哪几张、撞文件检查、小文件同步、命令行单子格式、领活规矩。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import { findFileConflicts, formatItemFile, itemFilePath, parseAllowedFiles, syncItemFiles } from "../../bookmark/item-files";
import { formatClaimMessage, handleCliRequest, parseCliArgs, parsePaihuoCards } from "../../bookmark/cli-server";
import { formatBrief, indexBoard } from "../../bookmark/board-index";

function tempStore(): { store: BookmarkStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-paihuo-"));
  return { store: new BookmarkStore(join(root, "bookmarks.json")), root };
}

const card = (text: string, assignee: string, files = "src/a.ts") => ({ text, detail: `目标：干活\n只许动：${files}`, assignee });

test("派活单一批：同一个批号、按写的顺序排在最上面、最多三张、重开还在", () => {
  const { store, root } = tempStore();
  try {
    store.add({ text: "老条目", assignee: "Pi Agent" });
    const made = store.addDispatchBatch([card("甲", "Pi Agent"), card("乙", "Pi Agent", "src/b.ts"), card("丙", "Claude", "src/c.ts")]);
    assert.equal(made.length, 3);
    assert.ok(made.every((r) => r.kind === "dispatch" && r.batchId === made[0].batchId && r.batchId));
    assert.deepEqual(store.list().slice(0, 3).map((r) => r.text), ["甲", "乙", "丙"]);
    assert.throws(() => store.addDispatchBatch([card("1", "Pi Agent"), card("2", "Pi Agent"), card("3", "Pi Agent"), card("4", "Pi Agent")]), /最多 3 张/);
    assert.throws(() => store.addDispatchBatch([]), /一张都没有/);
    const again = new BookmarkStore(join(root, "bookmarks.json"));
    const reread = again.list().find((r) => r.text === "乙")!;
    assert.equal(reread.kind, "dispatch");
    assert.equal(reread.batchId, made[0].batchId);
    // 普通条目、交接单没有批号
    assert.equal(again.list().find((r) => r.text === "老条目")!.batchId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("一键启动挑哪几张：同批、没人领、没交报告；拖到别的组批号不丢；删一张剩几张开几张", () => {
  const { store, root } = tempStore();
  try {
    const [a, b, c] = store.addDispatchBatch([card("甲", "Pi Agent"), card("乙", "Pi Agent", "src/b.ts"), card("丙", "Pi Agent", "src/c.ts")]);
    const other = store.addDispatchBatch([card("别批", "Pi Agent", "src/z.ts")]);
    assert.deepEqual(store.dispatchLaunchable(b.id).map((r) => r.text), ["甲", "乙", "丙"]);
    store.setAssignee(c.id, "Hermes"); // 拖去 Hermes 组
    assert.equal(store.list().find((r) => r.id === c.id)!.batchId, a.batchId);
    assert.deepEqual(store.dispatchLaunchable(a.id).map((r) => r.text), ["甲", "乙", "丙"]);
    store.claimNext(a.id, "PiAgent-1"); // 甲有人领了
    assert.deepEqual(store.dispatchLaunchable(c.id).map((r) => r.text), ["乙", "丙"]);
    store.remove(b.id);
    assert.deepEqual(store.dispatchLaunchable(c.id).map((r) => r.text), ["丙"]);
    assert.deepEqual(store.dispatchLaunchable(other[0].id).map((r) => r.text), ["别批"]);
    // 普通条目没有一键启动
    const note = store.add({ text: "普通", assignee: "Pi Agent" });
    assert.deepEqual(store.dispatchLaunchable(note.id), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AI 整理不碰派活单", () => {
  const { store, root } = tempStore();
  try {
    const [a] = store.addDispatchBatch([card("甲", "Pi Agent")]);
    assert.equal(store.aiMovable(a), false);
    assert.equal(store.aiMovable(store.add({ text: "普通", assignee: "Pi Agent" })), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("只许动：拆文件清单，没写是 null、写无是空", () => {
  assert.deepEqual(parseAllowedFiles("目标：x\n只许动：src/a.ts；src/b.ts、docs/"), ["src/a.ts", "src/b.ts", "docs/"]);
  assert.deepEqual(parseAllowedFiles("- 只许动: `src/a.ts`, 「src/c.ts」"), ["src/a.ts", "src/c.ts"]);
  assert.deepEqual(parseAllowedFiles("只许动：无（查资料）"), []);
  assert.equal(parseAllowedFiles("目标：x\n没写那一行"), null);
});

test("撞文件：同一份、一个是另一个所在的夹都算；斜杠方向和大小写不管", () => {
  const hits = findFileConflicts([
    { name: "Pi Agent 01", files: ["src/bookmark/renderer/bookmark.js"] },
    { name: "Pi Agent 02", files: ["SRC\\bookmark\\renderer\\"] },
    { name: "Claude 01", files: ["docs/a.md"] },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].a, "Pi Agent 01");
  assert.equal(hits[0].b, "Pi Agent 02");
  assert.deepEqual(findFileConflicts([{ name: "a", files: ["src/ab.ts"] }, { name: "b", files: ["src/a"] }]), []);
});

test("一条一份小文件：内容变了才写、条目没了就删、别的文件不碰", () => {
  const { store, root } = tempStore();
  const dir = join(root, "条目（一条一份）");
  const cache = new Map<string, string>();
  const render = (r: Parameters<typeof formatItemFile>[0]) => formatItemFile(r, { group: r.assignee ?? "待定", title: null });
  try {
    const note = store.add({ text: "第一条 [图片:x.png] 看看", assignee: "Claude" });
    const [d] = store.addDispatchBatch([card("派活甲", "Pi Agent")]);
    syncItemFiles(dir, store.list(), render, cache);
    const notePath = itemFilePath(dir, note.id);
    assert.ok(existsSync(notePath));
    assert.match(readFileSync(notePath, "utf8"), /看板「Claude」组的一条普通条目/);
    assert.match(readFileSync(itemFilePath(dir, d.id), "utf8"), /派活单：强模型拆好的活/);
    writeFileSync(join(dir, "别人的.txt"), "不许删");
    store.updateText(note.id, "改过的字");
    syncItemFiles(dir, store.list(), render, cache);
    assert.match(readFileSync(notePath, "utf8"), /改过的字/);
    store.remove(note.id);
    syncItemFiles(dir, store.list(), render, cache);
    assert.equal(existsSync(notePath), false);
    assert.deepEqual(readdirSync(dir).sort(), [`${d.id}.md`, "别人的.txt"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("命令行 paihuo：参数、单子格式、一批最多三张、必须写只许动", () => {
  assert.deepEqual(parseCliArgs(["paihuo", "--file", "a.json", "--to", "Claude"]), { command: "paihuo", file: "a.json", to: "Claude", json: false, attach: [] });
  assert.throws(() => parseCliArgs(["paihuo"]), /缺 --file/);
  const cards = parsePaihuoCards(JSON.stringify({ cards: [{ text: "甲", detail: "只许动：a.ts" }, { 标题: "乙", 详情: "只许动：无", 组: "Hermes" }] }), "Pi");
  assert.deepEqual(cards, [{ text: "甲", detail: "只许动：a.ts", assignee: "Pi" }, { text: "乙", detail: "只许动：无", assignee: "Hermes" }]);
  assert.deepEqual(parsePaihuoCards(JSON.stringify([{ text: "只许动：x.ts" }])), [{ text: "只许动：x.ts", detail: null, assignee: "" }]);
  assert.throws(() => parsePaihuoCards("不是json"), /不是合法 JSON/);
  assert.throws(() => parsePaihuoCards(JSON.stringify([{ text: "甲", detail: "没写" }])), /只许动/);
  assert.throws(() => parsePaihuoCards(JSON.stringify([1, 2, 3, 4].map((n) => ({ text: `${n}`, detail: "只许动：无" })))), /最多 3 张/);
});

test("命令行 /paihuo 接口：写进看板、回批号；领到派活单看到的是派活单规矩和单独文件路径", () => {
  const { store, root } = tempStore();
  try {
    const ctx = {
      token: "t",
      store: {
        add: (input: Parameters<BookmarkStore["add"]>[0]) => store.add(input),
        list: () => store.list(),
        remove: (id: string) => store.remove(id),
        addDispatchBatch: (cards: { text: string; detail: string | null; assignee: string }[]) => store.addDispatchBatch(cards.map((c) => ({ ...c, assignee: c.assignee || "Pi Agent" }))),
        itemFile: (id: string) => `X:/条目/${id}.md`,
        claimNext: (target: string, by: string) => store.claimNext(target, by),
      },
    };
    const reply = handleCliRequest("POST", "/paihuo", { cards: [card("甲", ""), card("乙", "Claude", "b.ts")] }, "Bearer t", ctx);
    assert.equal(reply.status, 200);
    const body = reply.body as { batchId: string; items: { id: string; assignee: string }[] };
    assert.deepEqual(body.items.map((i) => i.assignee), ["Pi Agent", "Claude"]);
    const next = handleCliRequest("POST", "/next", { target: body.items[0].id, by: "PiAgent-9" }, "Bearer t", ctx);
    const got = next.body as Parameters<typeof formatClaimMessage>[0] & { item: { kind: string } };
    assert.equal(got.item.kind, "dispatch");
    assert.equal(got.itemFile, `X:/条目/${body.items[0].id}.md`);
    const text = formatClaimMessage(got, { cli: "C:/cli.mjs", target: body.items[0].id, by: "PiAgent-9", coding: false });
    assert.match(text, /【看板派活单】你是 PiAgent-9/);
    assert.match(text, /只动单子里「只许动」写的文件/);
    assert.match(text, /report .* --by PiAgent-9/);
    assert.doesNotMatch(text, /done /);
    assert.match(text, /这条的单独文件/);
    // 列表里派活单带小尾巴
    const brief = formatBrief(indexBoard(store.list(), ["Claude", "Pi Agent"]), { titles: {}, bundleNames: {} }, "Pi");
    assert.match(brief, /（派活单）甲/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
