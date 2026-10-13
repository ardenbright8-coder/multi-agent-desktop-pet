// AI 整理看板 + 右键成捆（设定21，2026-10-12 用户拍板）：
// 手动捆以最后一次为准；用户动过的 AI 永远不碰；AI 只能放进已有捆或开新捆，说错的那条丢掉不连坐。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import {
  activeModel,
  buildCheckTask,
  buildGroupTask,
  buildItemTask,
  buildLedger,
  chat,
  freshNote,
  MAX_BUNDLE_NAME,
  noteKey,
  type NoteBook,
  runBundleNames,
  runItemNotes,
  checkModelInput,
  cleanBaseUrl,
  groupsForOrganizer,
  hardRulesText,
  liveHintBook,
  organizeRows,
  parseOrganizerConfig,
  parsePlanText,
  pruneRunRecords,
  runChecker,
  runOrganizer,
  shortSummary,
  validateCheck,
  validatePlan,
  type FetchFn,
  type HintBook,
} from "../../bookmark/organizer";

const LONG_AGO = Date.parse("2026-01-01T00:00:00Z");
const NOW = Date.now() + 10 * 60 * 1000; // 条目都「写完 10 分钟了」

function withStore(fn: (store: BookmarkStore) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-organizer-"));
  return Promise.resolve(fn(new BookmarkStore(join(root, "bookmarks.json")))).finally(() => rmSync(root, { recursive: true, force: true }));
}

/** 看板上从上到下的顺序加条目（add 是插到最前，所以倒着加）。 */
function seed(store: BookmarkStore, texts: string[], assignee = "Claude"): string[] {
  const ids: string[] = [];
  for (const t of [...texts].reverse()) ids.unshift(store.add({ text: t, assignee }).id);
  return ids;
}

function fakeModel(reply: unknown, calls: string[] = []): FetchFn {
  return async (_url, init) => {
    calls.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }] }) };
  };
}

const config = parseOrganizerConfig({ apiKey: "测试钥匙" });

test("设置：老格式（一个地址一把钥匙）搬成新格式，默认两个排前面、自己加的留着、坏值回落默认", () => {
  const c = parseOrganizerConfig({ apiKey: "k", models: ["my/model"], model: "my/model", intervalHours: 999 });
  assert.deepEqual(c.models.map((m) => m.model), ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "my/model"]);
  assert.ok(c.models.every((m) => m.provider === "Command Code" && m.apiKey === "k"), "原来的钥匙原样搬过去");
  assert.equal(activeModel(c).model, "my/model");
  assert.equal(c.intervalHours, 2);
  assert.equal(c.enabled, true);
  assert.equal(c.effort, "high", "默认高档（用户：两个小模型开到高档）");
  assert.equal(parseOrganizerConfig({ effort: "max" }).effort, "max");
  assert.equal(parseOrganizerConfig({ effort: "乱填" }).effort, "high");
  assert.equal(activeModel(parseOrganizerConfig(null)).model, "deepseek/deepseek-v4.1-flash");
});

test("设置：新格式每个模型自带地址和钥匙；地址整段贴也认；加模型要填全", () => {
  const c = parseOrganizerConfig({
    current: "ds",
    models: [
      { id: "cc", provider: "Command Code", baseUrl: "https://api.commandcode.ai/provider/v1", apiKey: "a", model: "deepseek/deepseek-v4.1-flash" },
      { id: "ds", provider: "DeepSeek 官方", baseUrl: "https://api.deepseek.com/v1/chat/completions/", apiKey: "b", model: "deepseek-chat" },
      { id: "bad", provider: "坏的", baseUrl: "不是地址", apiKey: "c", model: "x" },
    ],
  });
  assert.equal(c.models.length, 2, "地址不像样的丢掉");
  assert.equal(activeModel(c).baseUrl, "https://api.deepseek.com/v1");
  assert.equal(activeModel(c).apiKey, "b");
  assert.equal(cleanBaseUrl("https://x.com/v1/"), "https://x.com/v1");
  assert.throws(() => checkModelInput({ provider: "x", baseUrl: "https://x.com/v1", model: "m" }, true), /钥匙/);
  assert.throws(() => checkModelInput({ provider: "x", baseUrl: "x.com", apiKey: "k", model: "m" }, true), /http/);
  assert.equal(checkModelInput({ provider: "x", baseUrl: "https://x.com/v1", model: "m" }, false).apiKey, "", "改的时候钥匙留空＝不改");
});

test("有的家不认思考档位（回 400）：去掉再试一次", async () => {
  const bodies: string[] = [];
  const picky: FetchFn = async (_url, init) => {
    bodies.push(init.body);
    if (JSON.parse(init.body).reasoning_effort) return { ok: false, status: 400, text: async () => JSON.stringify({ error: "Unrecognized request argument supplied: reasoning_effort" }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "好" } }] }) };
  };
  assert.equal(await chat(activeModel(config), [], "high", picky), "好");
  assert.equal(bodies.length, 2);
});

test("手动成捆以最后一次为准：C 从旧捆出来进新捆，旧捆剩一条就散", () =>
  withStore((store) => {
    const [a, b, c, d] = seed(store, ["A", "B", "C", "D"]);
    store.createTaskBundle([a, c], "旧捆");
    const neu = store.createTaskBundle([c, d], "新捆");
    const rows = store.list();
    assert.equal(rows.find((r) => r.id === c)!.bundleId, neu.id);
    assert.equal(rows.find((r) => r.id === d)!.bundleId, neu.id);
    assert.equal(rows.find((r) => r.id === a)!.bundleId, null, "旧捆只剩 A，散掉");
    assert.equal(rows.find((r) => r.id === b)!.bundleId, null);
    assert.equal(store.bundleMeta()[neu.id].name, "新捆");
    assert.equal(store.bundleMeta()[neu.id].by, "user");
    assert.ok(rows.filter((r) => [c, d].includes(r.id)).every((r) => r.userPinned), "手动捆的标成用户动过");
  }));

test("交接单专区也能捆；待定区不捆；跨组不捆", () =>
  withStore((store) => {
    const h1 = store.add({ text: "交接一", kind: "handoff" }).id;
    const h2 = store.add({ text: "交接二", kind: "handoff" }).id;
    assert.ok(store.createTaskBundle([h1, h2], "").id);
    const i1 = store.add({ text: "想想一" }).id;
    const i2 = store.add({ text: "想想二" }).id;
    assert.throws(() => store.createTaskBundle([i1, i2], ""), /待定区不捆/);
    const [x] = seed(store, ["X"], "Claude");
    const [y] = seed(store, ["Y"], "Pi Agent");
    assert.throws(() => store.createTaskBundle([x, y], ""), /同一个分组/);
  }));

test("拆捆、拖进拖出都算用户动过；改派到别组＝在新组里是新条目", () =>
  withStore((store) => {
    const [a, b, c] = seed(store, ["A", "B", "C"]);
    const id = store.aiCreateBundle([a, b], "AI 捆");
    assert.equal(store.list().find((r) => r.id === a)!.userPinned, false, "AI 捆的不算用户动过");
    store.unbundle(id);
    assert.ok(store.list().filter((r) => [a, b].includes(r.id)).every((r) => r.userPinned));
    store.markSorted([c]);
    store.setAssignee(c, "Pi Agent");
    const moved = store.list().find((r) => r.id === c)!;
    assert.equal(moved.sortedAt, null);
    assert.equal(moved.userPinned, false);
  }));

test("出题：只送写完 3 分钟以上、散着、用户没动过的新条目；捆和旧条目做参考", () =>
  withStore((store) => {
    const [a, b, c, d] = seed(store, ["脑图新建不显示[图片:image-1.png]", "脑图新建打不开", "库面板返回键", "用户自己捆的"]);
    store.createTaskBundle([b, d], "用户捆");
    store.markSorted([c]);
    const group = groupsForOrganizer(store.list(), ["Claude"])[0];
    const task = buildGroupTask(group, { meta: store.bundleMeta(), openBundle: (x) => store.aiOpenBundle(x), now: NOW })!;
    assert.deepEqual(task.newAliases, ["N1"]);
    assert.equal(task.items.get("N1"), a);
    assert.equal(task.items.get("O1"), c);
    assert.equal(task.bundles.size, 1);
    assert.match(task.text, /B1「用户捆」/);
    assert.match(task.text, /N1 脑图新建不显示\[图\]/);
    assert.equal(buildGroupTask(group, { meta: {}, openBundle: () => true, now: Date.now() }), null, "刚写的不送");
  }));

test("过筛：编的编号、重复用、禁用捆名、新捆里没有新条目、放进不存在的捆——都丢掉", () =>
  withStore((store) => {
    seed(store, ["一", "二", "三", "四"]);
    const ids = store.list().map((r) => r.id);
    store.markSorted([ids[3]]);
    store.createTaskBundle([ids[2], ids[3]], "已有");
    const [g] = groupsForOrganizer(store.list(), ["Claude"]);
    const task = buildGroupTask(g, { meta: store.bundleMeta(), openBundle: () => true, now: NOW })!;
    const plan = validatePlan(
      parsePlanText("```json\n" + JSON.stringify({
        create: [
          { name: "杂项", items: ["N1", "N2"] },
          { name: "好名字", items: ["N1", "N9"] },
          { name: "好名字", items: ["N1", "N2"] },
        ],
        join: [{ item: "N1", bundle: "B1" }, { item: "N2", bundle: "B7" }],
        skip: [],
      }) + "\n```"),
      task,
    );
    assert.equal(plan.creates.length, 1);
    assert.deepEqual(plan.creates[0].ids, [ids[0], ids[1]]);
    assert.equal(plan.joins.length, 0, "N1 已用过、B7 不存在");
    assert.equal(plan.dropped.length, 4);
    assert.throws(() => parsePlanText("我觉得应该这样分"), /JSON/);
  }));

test("跑一轮：开新捆、放进已有捆，用户动过的不碰；第二轮没新条目不调模型", () =>
  withStore(async (store) => {
    const [a, b, c, d, e] = seed(store, ["脑图新建不显示", "脑图新建打不开", "库面板返回键", "库面板卡片", "用户手捆的"]);
    store.createTaskBundle([d, e], "库管理面板");
    const calls: string[] = [];
    const summary = await runOrganizer({
      store, agents: ["Claude"], config, now: NOW,
      fetchFn: fakeModel({ create: [{ name: "Markdown脑图新建", items: ["N1", "N2"], why: "都在说脑图新建" }], join: [{ item: "N3", bundle: "B1", why: "也是库管理面板" }], skip: [] }, calls),
    });
    const recRows = organizeRows(summary, store.list());
    assert.deepEqual(recRows.map((r) => r.action), ["开新捆", "放进"]);
    assert.equal(recRows[0].why, "都在说脑图新建", "理由带进记录（鼠标碰到那行冒出来）");
    assert.deepEqual(recRows[0].itemIds, [a, b]);
    const rows = store.list();
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    assert.ok(byId(a).bundleId && byId(a).bundleId === byId(b).bundleId);
    assert.equal(store.bundleMeta()[byId(a).bundleId!].by, "ai");
    assert.equal(byId(c).bundleId, byId(d).bundleId, "新条目进了用户的捆");
    assert.equal(byId(c).userPinned, false);
    assert.equal(byId(e).bundleId, byId(d).bundleId, "用户捆里原有的没被拿出来");
    assert.ok(rows.every((r) => r.sortedAt), "都标看过了");
    assert.equal(summary.changed, true);
    assert.match(shortSummary(summary), /1 个新捆.*1 条放进/);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]);
    assert.equal(body.model, "deepseek/deepseek-v4.1-flash");
    assert.match(body.messages[0].content, /项目名/);
    assert.match(body.messages[0].content, /why/, "规矩里要它写理由");
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.max_tokens, 32000, "高档给足输出上限，别让思考吃光");

    const again = await runOrganizer({ store, agents: ["Claude"], config, now: NOW, fetchFn: fakeModel({}, calls) });
    assert.equal(calls.length, 1, "没新条目就不花钱");
    assert.equal(again.groups.length, 0);
  }));

test("模型没回好：这组不标看过，下一轮再试；别的组照常", () =>
  withStore(async (store) => {
    seed(store, ["一", "二"], "Claude");
    seed(store, ["三", "四"], "Pi Agent");
    let n = 0;
    const flaky: FetchFn = async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 500, text: async () => "坏了" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"join":[],"create":[],"skip":["N1","N2"]}' } }] }) };
    };
    const s = await runOrganizer({ store, agents: ["Claude", "Pi Agent"], config, now: NOW, fetchFn: flaky });
    assert.match(s.groups[0].error ?? "", /500/);
    assert.ok(store.list().filter((r) => r.assignee === "Claude").every((r) => !r.sortedAt));
    assert.ok(store.list().filter((r) => r.assignee === "Pi Agent").every((r) => r.sortedAt));
  }));

test("在干的捆、多人派工捆，AI 不往里加", () =>
  withStore((store) => {
    const [a, b, c] = seed(store, ["A", "B", "C"], "Pi Agent");
    const coop = store.createTaskBundle([a, b], "派工", "主窗");
    assert.equal(store.aiOpenBundle(coop.id), false);
    assert.throws(() => store.aiJoinBundle(c, coop.id), /不能往里加/);
    const [x, y, z] = seed(store, ["X", "Y", "Z"], "Claude");
    const plain = store.createTaskBundle([x, y], "普通");
    store.claimNext(x, "窗口1");
    assert.equal(store.aiOpenBundle(plain.id), false);
    assert.throws(() => store.aiJoinBundle(z, plain.id));
  }));

test("改过的整理规矩会送给模型；全部重来连你捆的一起拆（在干的不拆），撤销能回原样", () =>
  withStore(async (store) => {
    const [a, , c, d, e, f] = seed(store, ["一", "二", "三", "四", "五", "六"]);
    const userBundle = store.createTaskBundle([c, d], "用户捆").id;
    const busyBundle = store.createTaskBundle([e, f], "在干的捆").id;
    store.claimNext(e, "窗口1");
    const calls: string[] = [];
    await runOrganizer({ store, agents: ["Claude"], config, now: NOW, rules: "我自己写的规矩",
      fetchFn: fakeModel({ create: [{ name: "一二这件事", items: ["N1", "N2"] }], join: [], skip: [] }, calls) });
    assert.equal(JSON.parse(calls[0]).messages[0].content, "我自己写的规矩");
    assert.ok(store.list().find((r) => r.id === a)!.bundleId);
    const snap = () => store.list().map((r) => `${r.id}:${r.bundleId}:${r.userPinned}:${Boolean(r.sortedAt)}`);
    const before = snap();
    assert.equal(store.canUndoReset(), false);
    assert.equal(store.aiResetAll(), 2, "AI 捆的和你捆的都拆，在干的那捆不算");
    const rows = store.list();
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    assert.equal(byId(a).bundleId, null);
    assert.equal(byId(c).bundleId, null, "你捆的也拆了");
    assert.equal(byId(c).userPinned, false, "你动过的也解锁");
    assert.equal(byId(c).sortedAt, null, "又当新条目");
    assert.equal(byId(e).bundleId, busyBundle, "在干的捆不碰");
    assert.ok(store.canUndoReset());
    const later = store.add({ text: "重来以后新来的", assignee: "Claude" }).id;
    assert.equal(store.undoReset(), 5, "在干的那条本来就没动，不用搬");
    assert.deepEqual(snap().filter((s) => !s.startsWith(later)), before, "撤销回到原样");
    assert.equal(store.list().find((r) => r.id === c)!.bundleId, userBundle);
    assert.equal(store.bundleMeta()[userBundle].name, "用户捆", "捆名也回来");
    assert.ok(store.list().some((r) => r.id === later), "新来的还在");
    assert.equal(store.canUndoReset(), false, "撤销一次就用掉了");
    assert.throws(() => store.undoReset(), /撤不了/);
  }));

test("检查：连你捆的一起看，只给提示不挪；编号不对的丢掉；点过「知道了」不再提；看板没变不再花钱", () =>
  withStore(async (store) => {
    const [a, b, c, d] = seed(store, ["看板 F1 置顶", "看板搜索框", "酒馆出图偏色", "酒馆套餐"]);
    store.createTaskBundle([a, b, c], "Agent看板");
    const [g] = groupsForOrganizer(store.list(), ["Claude"]);
    const task = buildCheckTask(g, { meta: store.bundleMeta(), openBundle: (x) => store.aiOpenBundle(x) })!;
    assert.match(task.text, /B1「Agent看板」[^]*I3 酒馆出图偏色[^]*散着的条目[^]*I4 酒馆套餐/);
    const clean = validateCheck({ hints: [{ item: "I3", to: "散着", why: "讲的是酒馆" }, { item: "I1", to: "B1" }, { item: "I9", to: "B1" }, { item: "I4", to: "散着" }] }, task);
    assert.equal(clean.hints.length, 1, "已经在 B1 不许 to B1、编的编号、散着的 to 散着，都丢");
    assert.equal(clean.hints[0].itemId, c);
    assert.equal(clean.hints[0].text, "可能不属于「Agent看板」捆");

    const calls: string[] = [];
    const reply = fakeModel({ hints: [{ item: "I3", to: "散着", why: "讲的是酒馆" }] }, calls);
    const empty: HintBook = { hints: [], dismissed: [], checked: {} };
    const r1 = await runChecker({ store, agents: ["Claude"], config, fetchFn: reply, book: empty });
    assert.equal(r1.newHints, 1);
    assert.equal(r1.book.hints[0].itemId, c);
    assert.equal(r1.rows[0].action, "提示");
    assert.equal(store.list().find((r) => r.id === c)!.bundleId, store.list().find((r) => r.id === a)!.bundleId, "一条都没挪");
    const r2 = await runChecker({ store, agents: ["Claude"], config, fetchFn: reply, book: r1.book });
    assert.equal(calls.length, 1, "看板没变不再问");
    assert.equal(r2.checkedGroups, 0);

    // 点「知道了」以后挪了别的条目，这组重查；这条还在原地 → 不再提示
    const dismissed: HintBook = { ...r2.book, hints: [], dismissed: [{ itemId: c, placement: r2.book.hints[0].placement }] };
    store.move(d, a, "above");
    const r3 = await runChecker({ store, agents: ["Claude"], config, fetchFn: reply, book: dismissed });
    assert.equal(calls.length, 2, "看板变了就重查");
    assert.equal(r3.newHints, 0, "点过知道了的不再提");
    // 这条挪了地方：「知道了」作废
    store.unbundle(store.list().find((r) => r.id === c)!.bundleId!);
    assert.equal(liveHintBook(r3.book, store.list()).dismissed.length, 0);
  }));

test("记录：条目删光的行去掉、最多留 50 次、新的在前；程序卡死的规矩拿常数拼", () => {
  const runs = Array.from({ length: 60 }, (_, i) => ({
    at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60000).toISOString(),
    model: "m",
    rows: [{ group: "Claude", action: "放进" as const, title: `第 ${i} 次`, why: "", itemIds: [i >= 55 ? "删了的" : "还在的"] }],
  }));
  const kept = pruneRunRecords(runs, new Set(["还在的"]));
  assert.equal(kept.length, 50);
  assert.equal(kept[0].rows[0].title, "第 54 次", "新的在前，删了的那几次没了");
  assert.match(hardRulesText(), /3 分钟/);
  assert.match(hardRulesText(), /杂项/);
});

test("账本：跟着看板现算，看过 / 没看过 / 你动过 / 捆，本月几轮", () =>
  withStore((store) => {
    const [a, b, c] = seed(store, ["一", "二", "三"]);
    store.createTaskBundle([a, b], "你的捆");
    store.markSorted([c]);
    const runs = [
      { at: new Date(2026, 9, 12, 7, 26).toISOString(), model: "m", rows: [] },
      { at: new Date(2026, 8, 30, 10, 0).toISOString(), model: "m", rows: [] },
    ];
    const ledger = buildLedger(store.list(), ["Claude"], store.bundleMeta(), runs, new Date(2026, 9, 12, 12).getTime());
    assert.equal(ledger.runsThisMonth, 1);
    assert.equal(ledger.lastRun, "2026-10-12 07:26 · m");
    const g = ledger.groups[0];
    assert.equal(g.counts["你动过"], 2);
    assert.equal(g.counts["看过"], 1);
    assert.deepEqual(g.bundles, [{ name: "你的捆", by: "user", count: 2 }]);
    store.remove(c);
    assert.equal(buildLedger(store.list(), ["Claude"], store.bundleMeta(), []).groups[0].items.length, 2, "删了账本里也没了");
  }));

// ── 第五版（2026-10-13 用户）：一条一条读、每张图都看，写小标题和小结；再拿小结分捆；捆里加了条目重写捆名 ──

test("读条目：一条一问，只带这条自己的图；图片标记换成 [图1] 对上号；读过的不再读，改了字重读；读不成的不连坐", () =>
  withStore(async (store) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-pet-notes-"));
    try {
      for (const f of ["image-a1.png", "image-a2.png", "image-b1.png"]) writeFileSync(join(dir, f), "png");
      const [a, b, c] = seed(store, ["返回箭头没反应[图片:image-a1.png]你看这里[图片:image-a2.png]", "酒馆黑框太多[图片:image-b1.png]", "坏的那条"]);
      const one = buildItemTask(store.list().find((r) => r.id === a)!, dir);
      assert.equal(one.images.length, 2);
      assert.match(one.text, /返回箭头没反应\[图1\]你看这里\[图2\]/);
      assert.match(one.text, /2 张图/);

      const bodies: string[] = [];
      const fetchFn: FetchFn = async (_url, init) => {
        bodies.push(init.body);
        const user = JSON.stringify(JSON.parse(init.body).messages[1]);
        if (user.includes("坏的那条")) return { ok: false, status: 500, text: async () => "坏了" };
        const title = user.includes("返回箭头") ? "返回箭头：点了没反应要修" : "看图界面：两边黑框收窄";
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ project: "库管理面板", title, summary: "要修" }) } }] }) };
      };
      const r1 = await runItemNotes({ store, agents: ["Claude"], config, fetchFn, book: {}, attachmentsDir: dir, now: NOW });
      assert.equal(bodies.length, 3, "三条各问一次");
      assert.equal(r1.read, 2);
      assert.deepEqual(r1.errors.map((e) => e.id), [c], "坏的那条记下来，别的照常");
      const aBody = bodies.map((x) => JSON.parse(x)).find((x) => JSON.stringify(x.messages[1]).includes("返回箭头"));
      assert.equal(aBody.messages[1].content.filter((p: { type: string }) => p.type === "image_url").length, 2, "这条的两张图都带上");
      assert.match(aBody.messages[0].content, /每一张图都看/);
      assert.equal(r1.book[a].title, "返回箭头：点了没反应要修");
      assert.ok(freshNote(store.list().find((r) => r.id === b)!, r1.book));

      bodies.length = 0;
      store.updateText(b, "酒馆黑框太多，对比也难[图片:image-b1.png]");
      const r2 = await runItemNotes({ store, agents: ["Claude"], config, fetchFn, book: r1.book, attachmentsDir: dir, now: NOW });
      assert.equal(bodies.length, 2, "只重读改了字的和上次没读成的");
      assert.equal(r2.read, 1);
      store.remove(a);
      const r3 = await runItemNotes({ store, agents: ["Claude"], config, fetchFn, book: r2.book, attachmentsDir: dir, now: NOW });
      assert.equal(r3.book[a], undefined, "条目删了，小卡片跟着删");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("分捆拿小卡片出题、不再带原图；捆名全交给 AI：变了的捆重写，没变的不花钱，派工捆不碰", () =>
  withStore(async (store) => {
    const [a, b, c, d, e, f] = seed(store, ["一[图片:x.png]", "二", "三", "四", "五", "六"]);
    const aiBundle = store.aiCreateBundle([b, c], "库管理面板：返回键");
    const userBundle = store.createTaskBundle([d, e], "我起的名").id;
    const notes: NoteBook = {};
    for (const [id, title] of [[a, "图标：先弹新窗口"], [b, "返回键：点了没反应"], [c, "管理：每层都有"], [f, "规矩模板：找不到"]] as const) {
      notes[id] = { project: "库管理面板", title, summary: `${title}的小结`, key: noteKey(store.list().find((r) => r.id === id)!) };
    }
    const [g] = groupsForOrganizer(store.list(), ["Claude"]);
    const task = buildGroupTask(g, { meta: store.bundleMeta(), openBundle: (x) => store.aiOpenBundle(x), now: NOW, notes, attachmentsDir: tmpdir() })!;
    assert.match(task.text, /N1 【库管理面板】图标：先弹新窗口｜图标：先弹新窗口的小结/);
    assert.equal(task.images.length, 0, "读过的条目不再带原图");

    const calls: string[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      calls.push(init.body);
      n += 1;
      const reply = n === 1
        ? { join: [{ item: "N1", bundle: "B1", why: "也是库管理面板" }, { item: "N2", bundle: "B2", why: "也是库管理面板" }], create: [], skip: [] }
        : { name: "库管理面板：返回键没反应·每层都有管理·图标先弹新窗口" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
    };
    const summary = await runOrganizer({ store, agents: ["Claude"], config, now: NOW, fetchFn, notes });
    assert.equal(calls.length, 1, "分捆只问一次，改名另一步");
    assert.deepEqual(organizeRows(summary, store.list()).map((r) => r.action), ["放进", "放进"]);

    // 起名这一步：两捆都变了（各进了一条），AI 捆、你起名的捆都重写（捆名全交给 AI）
    const named = await runBundleNames({ store, agents: ["Claude"], config, fetchFn, notes, book: {} });
    assert.equal(calls.length, 3, "两捆各问一次");
    const nameAsk = JSON.parse(calls[1]);
    assert.match(nameAsk.messages[0].content, /每一条都要有份/);
    assert.equal(store.bundleMeta()[aiBundle].name, "库管理面板：返回键没反应·每层都有管理·图标先弹新窗口");
    assert.equal(store.bundleMeta()[userBundle].name, "库管理面板：返回键没反应·每层都有管理·图标先弹新窗口", "你起名的也交给 AI");
    assert.equal(store.bundleMeta()[userBundle].by, "user", "起名不改「谁捆的」");
    assert.deepEqual(named.rows.map((r) => r.action), ["改捆名", "改捆名"]);
    // 没变的不再花钱；挪一条出去就重写那一捆
    await runBundleNames({ store, agents: ["Claude"], config, fetchFn, notes, book: named.book });
    assert.equal(calls.length, 3, "没变的不再问");
    store.move(f, a, "above", null);
    const again = await runBundleNames({ store, agents: ["Claude"], config, fetchFn, notes, book: named.book });
    assert.equal(calls.length, 4, "条目进出过的那一捆重写");
    assert.equal(again.rows.length, 0, "名字一样就不记一行");
    // 多人派工捆不碰
    const [x, y] = seed(store, ["派一", "派二"], "Pi Agent");
    const coop = store.createTaskBundle([x, y], "派工", "主窗");
    assert.equal(store.aiCanName(coop.id), false);
    assert.equal(MAX_BUNDLE_NAME, 39);
    assert.match(hardRulesText(), /每张图/);
  }));
