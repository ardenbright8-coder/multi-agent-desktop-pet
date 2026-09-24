// 睡觉档单测（2026-09-24 用户：人睡觉时给 AI 排一堆活，它干完一条写好大白话结果就接着领下一条，早上起来查；
// 分日常档、睡觉档两档）。期望答案都在这里手写，不拿被测函数算。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import { formatClaimMessage, handleCliRequest, parseCliArgs, type CliRecord, type CliStoreAdapter } from "../../bookmark/cli-server";
import { planNudges, parseBoardMode } from "../../bookmark/sleep-mode";

function withStore(fn: (store: BookmarkStore, path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-sleep-"));
  try {
    const path = join(root, "bookmarks.json");
    fn(new BookmarkStore(path), path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Claude 组从上到下 甲 乙 丙，Pi Agent 组一条 子。 */
function seed(store: BookmarkStore): Record<string, string> {
  const ids: Record<string, string> = {};
  ids.子 = store.add({ text: "子", assignee: "Pi Agent" }).id;
  for (const text of ["丙", "乙", "甲"]) ids[text] = store.add({ text, assignee: "Claude" }).id;
  return ids;
}

test("report：领的人写大白话报告 → 标成干完待审、不删、领活标记清掉；不是自己领的、报告是空的都不收", () => {
  withStore((store) => {
    const ids = seed(store);
    store.claimNext(ids.甲, "Claude-1");
    assert.throws(() => store.report(ids.甲, "Claude-2", "做完了"), /不是你领的/);
    assert.throws(() => store.report(ids.甲, "Claude-1", "  "), /报告/);
    const r = store.report(ids.甲, "Claude-1", "改好了搜索框，重开看板能看见");
    assert.equal(r.report, "改好了搜索框，重开看板能看见");
    assert.equal(r.reportedBy, "Claude-1");
    assert.ok(r.reportedAt);
    assert.equal(r.claimedBy, null);
    assert.equal(store.list().filter((x) => x.assignee === "Claude").length, 3, "报告了也不删，等用户看");
  });
});

test("claimInGroup：按看板从上到下领这组第一条没人领、没报告的；组名大小写不管；自己手里有就还是那条", () => {
  withStore((store) => {
    const ids = seed(store);
    const a = store.claimInGroup("claude", "Claude-1");
    assert.equal(a.record?.text, "甲");
    assert.deepEqual([a.position, a.total, a.remaining], [1, 3, 2]);
    assert.equal(store.claimInGroup("Claude", "Claude-1").record?.text, "甲", "没干完再敲还是那条");
    assert.equal(store.claimInGroup("Claude", "Claude-2").record?.text, "乙", "别人领走的跳过");
    store.report(ids.甲, "Claude-1", "好了");
    assert.equal(store.claimInGroup("Claude", "Claude-1").record?.text, "丙", "报告过的不再领");
    const none = store.claimInGroup("Claude", "Claude-3");
    assert.equal(none.record, null);
    assert.deepEqual(none.busy.sort(), ["Claude-1", "Claude-2"]);
    assert.equal(store.claimInGroup("Pi Agent", "PiAgent-1").record?.text, "子");
  });
});

test("claimNext（按捆号或条目领）也跳过报告过的", () => {
  withStore((store) => {
    const ids = seed(store);
    store.bundleWith(ids.乙, ids.甲);
    const bundle = store.list().find((r) => r.id === ids.甲)!.bundleId!;
    store.claimNext(bundle, "Claude-1");
    store.report(ids.甲, "Claude-1", "好了");
    const next = store.claimNext(bundle, "Claude-1");
    assert.equal(next.record?.text, "乙");
    assert.equal(next.remaining, 0);
  });
});

test("旧库没有报告字段读进来是 null", () => {
  withStore((_store, path) => {
    writeFileSync(path, JSON.stringify([{ id: "x", text: "老条目", createdAt: "2026-09-01T00:00:00.000Z", assignee: "Claude" }]));
    const r = new BookmarkStore(path).list()[0];
    assert.equal(r.report, null);
    assert.equal(r.reportedBy, null);
    assert.equal(r.reportedAt, null);
  });
});

test("parseBoardMode：只认 sleep，别的一律日常档；坏档也是日常档", () => {
  assert.equal(parseBoardMode('{"mode":"sleep"}'), "sleep");
  assert.equal(parseBoardMode('{"mode":"day"}'), "day");
  assert.equal(parseBoardMode('{"mode":"SLEEP"}'), "day");
  assert.equal(parseBoardMode("不是 json"), "day");
  assert.equal(parseBoardMode(""), "day");
});

test("planNudges：有活没人干的组开窗（一次），有人在干就不开并且记账清掉；报告过的不算活", () => {
  const rows = [
    { assignee: "Claude", claimedBy: null, report: null },
    { assignee: "claude", claimedBy: null, report: null },
    { assignee: "Pi Agent", claimedBy: "PiAgent-2", report: null },
    { assignee: "Pi Agent", claimedBy: null, report: null },
    { assignee: "Hermes", claimedBy: null, report: "好了" },
    { assignee: null, claimedBy: null, report: null },
  ];
  const plan = planNudges(rows, ["Claude", "Pi Agent", "Hermes", "ChatGPT"], new Set(["Pi Agent"]));
  assert.deepEqual(plan.launch, ["Claude"]);
  assert.deepEqual(plan.clear, ["Pi Agent"]);
  const again = planNudges(rows, ["Claude"], new Set(["Claude"]));
  assert.deepEqual(again.launch, [], "开过一次、还没人来领，就不再开");
});

test("parseCliArgs：next --to 组名（不带捆号）、report 带 --text 大白话；缺东西报错", () => {
  assert.deepEqual(parseCliArgs(["next", "--to", "Pi Agent", "--by", "PiAgent-3"]),
    { command: "next", to: "Pi Agent", by: "PiAgent-3", coding: false, json: false, attach: [] });
  assert.deepEqual(parseCliArgs(["report", "id-1", "--by", "Claude-3", "--text", "改好了", "重开能看见"]),
    { command: "report", target: "id-1", by: "Claude-3", text: "改好了 重开能看见", coding: false, json: false, attach: [] });
  assert.throws(() => parseCliArgs(["report", "id-1", "--by", "Claude-3"]), /--text/);
  assert.throws(() => parseCliArgs(["next", "--by", "Claude-3"]), /捆号或条目 id/);
});

function makeSleepCtx(mode: "day" | "sleep") {
  const calls: string[] = [];
  const record: CliRecord = {
    id: "id-9", text: "搜索框看不见", url: null, assignee: "Claude", dedupeKey: null, detail: null,
    kind: "note", attachments: [], createdAt: "2026-09-24T00:00:00.000Z", bundleId: null, claimedBy: null,
  };
  const store: CliStoreAdapter = {
    add: () => record,
    list: () => [record],
    remove: () => true,
    claimNext: () => ({ record, position: 1, total: 1, remaining: 0, busy: [] }),
    claimInGroup(group, by) {
      calls.push(`group ${group} ${by}`);
      record.claimedBy = by;
      return { record, position: 1, total: 2, remaining: 1, busy: [] };
    },
    report(id, by, text) {
      calls.push(`report ${id} ${by} ${text}`);
      return record;
    },
    mode: () => mode,
  };
  return { ctx: { token: "t", store, onChanged: () => { calls.push("changed"); } }, calls };
}

test("handleCliRequest：/next 带 group 按组领、回包带档位；/report 缺报告 400、正常 200 并刷新看板", () => {
  const { ctx, calls } = makeSleepCtx("sleep");
  const got = handleCliRequest("POST", "/next", { group: "Claude", by: "Claude-3" }, "Bearer t", ctx);
  assert.equal(got.status, 200);
  assert.equal((got.body as { mode: string }).mode, "sleep");
  assert.ok(calls.includes("group Claude Claude-3"));
  assert.equal(handleCliRequest("POST", "/report", { id: "id-9", by: "Claude-3", text: " " }, "Bearer t", ctx).status, 400);
  const ok = handleCliRequest("POST", "/report", { id: "id-9", by: "Claude-3", text: "改好了" }, "Bearer t", ctx);
  assert.equal(ok.status, 200);
  assert.ok(calls.includes("report id-9 Claude-3 改好了"));
  assert.ok(calls.includes("changed"));
  const day = makeSleepCtx("day");
  assert.equal((handleCliRequest("POST", "/next", { target: "id-9", by: "Claude-3" }, "Bearer t", day.ctx).body as { mode: string }).mode, "day");
});

test("formatClaimMessage 睡觉档：不等用户说可以、写大白话 report、接着按组 next、快没额度先写交接单再放回去、拿不准的不干", () => {
  const msg = formatClaimMessage(
    { item: { id: "id-9", assignee: "Pi Agent" } as CliRecord, prompt: "搜索框看不见", position: 1, total: 2, remaining: 1, busy: [], mode: "sleep" },
    { cli: "X:/bookmark-cli.mjs", target: "id-9", by: "PiAgent-3", coding: false },
  );
  assert.match(msg, /睡觉档/);
  assert.match(msg, /不用等他说「可以」/);
  assert.match(msg, /node "X:\/bookmark-cli\.mjs" report id-9 --by PiAgent-3 --text "/);
  assert.match(msg, /大白话/);
  assert.match(msg, /node "X:\/bookmark-cli\.mjs" next --to "Pi Agent" --by PiAgent-3/);
  assert.match(msg, /node "X:\/bookmark-cli\.mjs" handoff ".*" --to "Pi Agent" --detail "/);
  assert.match(msg, /release id-9 --by PiAgent-3/);
  assert.match(msg, /删东西|动系统/);
  assert.doesNotMatch(msg, / done /, "睡觉档不许 done");
  const day = formatClaimMessage(
    { item: { id: "id-9", assignee: "Claude" } as CliRecord, prompt: "x", position: 1, total: 1, remaining: 0, busy: [], mode: "day" },
    { cli: "X:/bookmark-cli.mjs", target: "", group: "Claude", by: "Claude-3", coding: false },
  );
  assert.match(day, /done id-9 --by Claude-3 --ok "/);
  assert.match(day, /next --to "Claude" --by Claude-3/, "日常档用组名领的，下一条也按组领");
});
