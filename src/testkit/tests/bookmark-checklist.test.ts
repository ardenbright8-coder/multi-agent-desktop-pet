// 打勾清单单测（2026-10-28 用户：单子越堆越多、干完了没人删；AI 只拨开关，全勾完单子自己没了）。
// 两层清单、小项全勾完上一层自动算完、命令行两个口子、领活只吐没勾的、全勾完自动收、两份副本文件。期望答案手写，不拿被测函数算。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doneLogPath, BookmarkStore } from "../../bookmark/store";
import { formatClaimMessage, formatTickResult, handleCliRequest, parseCliArgs, type CliStoreAdapter } from "../../bookmark/cli-server";
import { formatPending, parseChecklist, toggleItem } from "../../bookmark/checklist";
import { formatItemFiles, syncItemFiles } from "../../bookmark/item-files";

function withStore(fn: (store: BookmarkStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-checklist-"));
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
    appendProgress: (id, by, text) => store.appendProgress(id, by, text),
    setChecklist: (id, items, by) => store.setChecklist(id, items, by),
    tick: (id, no, by) => store.tick(id, no, by),
    boardNames: () => ({ agents: ["Claude"], titles: {}, bundleNames: {} }),
  } as CliStoreAdapter;
}

const post = (store: BookmarkStore, path: string, body: unknown) =>
  handleCliRequest("POST", path, body, "Bearer t", { token: "t", store: adapter(store) });

const MD = [
  "# 整理好的清单",
  "- [ ] 1 数据",
  "  - [ ] 1.1 存清单",
  "  - [ ] 1.2 两份副本",
  "- [ ] 改规矩",
  "- [ ] 3 收尾",
].join("\n");

test("解析：两层，编号按结构重排；写了 1.1 不缩进也算小项；非打勾行跳过", () => {
  const items = parseChecklist("说明文字\n- [ ] 5 甲\n- [ ] 9.9 甲下面的\n- [x] 乙\n    - [ ] 乙下面的");
  assert.deepEqual(items.map((x) => `${x.no} ${x.text} ${x.done}`), ["1 甲 false", "1.1 甲下面的 false", "2 乙 false", "2.1 乙下面的 false"],
    "乙自己写了 [x] 但小项没勾，上一层不算完");
  assert.throws(() => parseChecklist("- [ ] 1.1 没有上一层"), /前面没有上一层/);
  assert.throws(() => parseChecklist("随便写的"), /一项都没有/);
});

test("拨开关：小项全勾完上一层自己勾上；勾上一层＝小项一起勾；再勾一次取消", () => {
  let items = parseChecklist(MD);
  items = toggleItem(items, "1.1", "Claude-3", "2026-10-28T01:00:00Z");
  assert.equal(items.find((x) => x.no === "1")!.done, false);
  items = toggleItem(items, "1.2", "Claude-3", "2026-10-28T01:05:00Z");
  assert.equal(items.find((x) => x.no === "1")!.done, true, "两个小项都勾了，1 自动算完");
  assert.equal(items.find((x) => x.no === "1")!.by, "Claude-3");
  items = toggleItem(items, "1.2", "Claude-3", "2026-10-28T01:06:00Z");
  assert.equal(items.find((x) => x.no === "1")!.done, false, "取消一个小项，1 跟着回到没完");
  items = toggleItem(items, "1", "Claude-3", "2026-10-28T01:07:00Z");
  assert.deepEqual(items.filter((x) => x.no.startsWith("1")).map((x) => x.done), [true, true, true], "勾上一层，小项一起勾");
  assert.equal(formatPending(items), "- [ ] 2 改规矩\n- [ ] 3 收尾");
  assert.throws(() => toggleItem(items, "7", "x", "t"), /没有 7 这一项，有的是：1 1\.1 1\.2 2 3/);
});

test("命令行：清单 / 勾 中英文都认；勾 一次几项；缺东西当场报", () => {
  const a = parseCliArgs(["清单", "12", "--file", "a.md", "--by", "Claude-3"]);
  assert.deepEqual([a.command, a.target, a.file, a.by], ["checklist", "12", "a.md", "Claude-3"]);
  const b = parseCliArgs(["勾", "abc-1", "2.1", "2.2,3"]);
  assert.deepEqual([b.command, b.target, b.nos, b.by], ["tick", "abc-1", ["2.1", "2.2", "3"], undefined]);
  assert.equal(parseCliArgs(["tick", "x", "1"]).command, "tick");
  assert.throws(() => parseCliArgs(["清单", "12", "--by", "C"]), /--file/);
  assert.throws(() => parseCliArgs(["清单", "12", "--file", "a.md"]), /--by/);
  assert.throws(() => parseCliArgs(["勾", "12"]), /项号/);
});

test("全流程：交清单（号码认得）→ 勾 → 全勾完自动收掉、管着的条目一起删、写做完记录", () =>
  withStore((store) => {
    const 原条 = store.add({ text: "原来那条", assignee: "Claude" }).id;
    const card = store.add({ text: "口语单子", kind: "handoff", detail: "他说的一大段", links: [原条] }).id;
    store.claimNext(card, "Claude-3");
    // 号码：Claude 组 01 是原来那条，交接单专区 02 是这张
    const set = post(store, "/checklist", { id: "02", by: "Claude-3", md: MD });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(post(store, "/checklist", { id: card, by: "Claude-9", md: MD }).status, 400, "别人领着的交不进去");
    const rec = store.list().find((r) => r.id === card)!;
    assert.equal(rec.detail, "他说的一大段", "原话不动");
    assert.equal(rec.checklist!.length, 5);

    const one = post(store, "/tick", { id: card, nos: ["1.1", "1.2"] });
    assert.deepEqual((one.body as { done: number; total: number }).done, 1);
    assert.equal(formatTickResult(one.body as never), "✔ 1.1  ✔ 1.2（1/3）");
    assert.equal(store.list().find((r) => r.id === card)!.checklist!.find((x) => x.no === "1.1")!.by, "Claude-3", "没写 --by 记成领着的窗口");

    const last = post(store, "/tick", { id: card, nos: ["2", "3"] });
    const body = last.body as { closed: boolean; linksRemoved: number };
    assert.equal(body.closed, true);
    assert.equal(body.linksRemoved, 1);
    assert.deepEqual(store.list().map((r) => r.text), [], "单子和它管着的那条都没了");
    assert.match(readFileSync(doneLogPath(join(store["path"] as string)), "utf8"), /「口语单子」3 项全勾完，Claude-3 勾的最后一项，自动收掉（连管着的 1 条）/);
    assert.equal(post(store, "/tick", { id: card, nos: ["1"] }).status, 404, "收掉以后再勾说找不到");
  }));

test("做完记录只留最近 50 条，新的在上面", () =>
  withStore((store) => {
    for (let i = 1; i <= 52; i++) {
      const id = store.add({ text: `第${i}张` }).id;
      store.setChecklist(id, parseChecklist("- [ ] 1 一项"), "C");
      store.tick(id, "1", "C");
    }
    const lines = readFileSync(doneLogPath(store["path"] as string), "utf8").split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 50);
    assert.match(lines[0], /第52张/);
    assert.match(lines[49], /第3张/);
  }));

test("领活：有清单只吐没勾的几行＋最后一句进度，不吐原话；没清单的交接单先叫整理", () =>
  withStore((store) => {
    const card = store.add({ text: "单子", kind: "handoff", detail: "原话里的秘密细节" }).id;
    const claim = store.claimNext(card, "Claude-3");
    const bare = formatClaimMessage({ item: claim.record, prompt: "原话里的秘密细节", position: 1, total: 1, remaining: 0, busy: [] }, { cli: "x.mjs", target: card, by: "Claude-3", coding: false });
    assert.match(bare, /【先整理清单】/);
    assert.match(bare, /看板 清单 .+ --file 清单\.md --by Claude-3/);

    store.setChecklist(card, parseChecklist(MD), "Claude-3");
    store.tick(card, "1", "Claude-3");
    store.appendProgress(card, "Claude-3", "数据做完了");
    const rec = store.list()[0];
    const msg = formatClaimMessage(
      { item: rec, prompt: "原话里的秘密细节", position: 1, total: 1, remaining: 0, busy: [], originalFile: "D:/x（原话）.md", lastProgress: "10-28 01:00 Claude-3：数据做完了" },
      { cli: "x.mjs", target: card, by: "Claude-3", coding: false },
    );
    assert.doesNotMatch(msg, /秘密细节/, "原话不吐");
    assert.doesNotMatch(msg, /【先整理清单】/);
    assert.match(msg, /【打勾清单 1\/3】还没勾的：\n- \[ \] 2 改规矩\n- \[ \] 3 收尾\n最后一句进度：10-28 01:00 Claude-3：数据做完了/);
    assert.match(msg, /看板 勾 .+ 2\.1/);
    assert.doesNotMatch(msg, /done /, "有清单不用 done");
    assert.match(msg, /D:\/x（原话）\.md/);
  }));

test("副本文件：有清单分两份（清单＋原话），清单收掉两份一起删", () =>
  withStore((store, root) => {
    const id = store.add({ text: "单子", kind: "handoff", detail: "原话详情" }).id;
    store.claimNext(id, "Claude-3");
    store.setChecklist(id, parseChecklist(MD), "Claude-3");
    store.tick(id, "1.1", "Claude-3");
    const files = formatItemFiles(store.list()[0], { group: "交接单专区", title: "小标题" });
    assert.match(files.main, /## 打勾清单（0\/3）\n\n- \[ \] 1 数据\n  - \[x\] 1\.1 存清单（Claude-3 .+ 勾）\n  - \[ \] 1\.2 两份副本/);
    assert.doesNotMatch(files.main, /原话详情/, "清单那份不带原话");
    assert.match(files.original ?? "", /原话详情/);

    const dir = join(root, "条目");
    const cache = new Map<string, string>();
    const render = (r: Parameters<typeof formatItemFiles>[0]) => formatItemFiles(r, { group: "交接单专区" });
    syncItemFiles(dir, store.list(), render, cache);
    assert.ok(existsSync(join(dir, `${id}.md`)) && existsSync(join(dir, `${id}（原话）.md`)));
    store.tick(id, "1", "Claude-3");
    store.tick(id, "2", "Claude-3");
    store.tick(id, "3", "Claude-3");
    syncItemFiles(dir, store.list(), render, cache);
    assert.ok(!existsSync(join(dir, `${id}.md`)) && !existsSync(join(dir, `${id}（原话）.md`)), "收掉以后两份都删");
  }));

test("清单和进度存盘重开还在；老库没有这两栏不多出空字段", () =>
  withStore((store, root) => {
    const id = store.add({ text: "单子" }).id;
    store.add({ text: "老条目" });
    store.claimNext(id, "C");
    store.setChecklist(id, parseChecklist(MD), "C");
    store.appendProgress(id, "C", "第一句");
    const again = new BookmarkStore(join(root, "bookmarks.json")).list();
    assert.equal(again.find((r) => r.id === id)!.checklist!.length, 5);
    assert.match(again.find((r) => r.id === id)!.progress![0], /C：第一句$/);
    assert.ok(!("checklist" in again.find((r) => r.text === "老条目")!));
    assert.ok(!("progress" in again.find((r) => r.text === "老条目")!));
  }));
