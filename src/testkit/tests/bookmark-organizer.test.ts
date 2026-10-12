// AI 整理看板 + 右键成捆（设定21，2026-10-12 用户拍板）：
// 手动捆以最后一次为准；用户动过的 AI 永远不碰；AI 只能放进已有捆或开新捆，说错的那条丢掉不连坐。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BookmarkStore } from "../../bookmark/store";
import {
  buildGroupTask,
  groupsForOrganizer,
  parseOrganizerConfig,
  parsePlanText,
  runOrganizer,
  shortSummary,
  validatePlan,
  type FetchFn,
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

test("设置：默认两个模型、自己加的模型留着、坏值回落默认", () => {
  const c = parseOrganizerConfig({ models: ["my/model"], model: "my/model", intervalHours: 999 });
  assert.deepEqual(c.models, ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "my/model"]);
  assert.equal(c.model, "my/model");
  assert.equal(c.intervalHours, 2);
  assert.equal(c.enabled, true);
  assert.equal(parseOrganizerConfig(null).model, "deepseek/deepseek-v4.1-flash");
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
      fetchFn: fakeModel({ create: [{ name: "Markdown脑图新建", items: ["N1", "N2"] }], join: [{ item: "N3", bundle: "B1" }], skip: [] }, calls),
    });
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
