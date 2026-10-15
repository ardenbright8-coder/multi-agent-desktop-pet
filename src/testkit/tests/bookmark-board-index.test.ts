// 按号码读（2026-10-13 用户：说「第 9 条」「捆2」，AI 只读点名的那几条）：号码跟看板一个数法（2026-10-15 起全板统一编号）、只列标题、点名才吐全文。

import assert from "node:assert/strict";
import test from "node:test";
import { findGroup, formatBrief, formatShow, indexBoard, parseShowSpec } from "../../bookmark/board-index";
import type { CliRecord } from "../../bookmark/cli-server";
import { parseCliArgs } from "../../bookmark/cli-server";

function rec(id: string, text: string, extra: Partial<CliRecord> = {}): CliRecord {
  return { id, text, url: null, assignee: "Claude", dedupeKey: null, detail: null, kind: "note", attachments: [], createdAt: "2026-10-13T00:00:00Z", bundleId: null, ...extra };
}

// 看板上 Claude 组从上到下：散条 a、捆一(b c)、散条 d、捆二(e f)；Pi 组一个捆三(p q)；另有交接单专区一张、待定一条、派给已删组的一条
const records: CliRecord[] = [
  rec("a", "第一条原文很长很长"),
  rec("b", "捆一第一条", { bundleId: "B1" }),
  rec("c", "捆一第二条", { bundleId: "B1", claimedBy: "Claude-3" }),
  rec("h", "交接单标题", { assignee: null, kind: "handoff", detail: "六块详情" }),
  rec("d", "第四条", { report: "干完了" }),
  rec("e", "捆二第一条[图片:image-x.png]后面", { bundleId: "B2" }),
  rec("f", "捆二第二条", { bundleId: "B2" }),
  rec("p", "Pi 捆里第一条", { assignee: "Pi Agent", bundleId: "B3" }),
  rec("q", "Pi 捆里第二条", { assignee: "Pi Agent", bundleId: "B3" }),
  rec("i", "想想再说", { assignee: null }),
  rec("g", "派给已删组的", { assignee: "旧组" }),
];
const names = { titles: { a: "小标题A", e: "小标题E" }, bundleNames: { B1: "捆一的名字" } };
const groups = indexBoard(records, ["Claude", "Pi Agent"]);

test("号码全板统一：各组照组名单 → 交接单专区 → 待定一路往下编，捆号也全板接着数；派给已删组的回待定", () => {
  const claude = findGroup(groups, "claude")!;
  assert.deepEqual(claude.rows.map((r) => [r.no, r.record.id, r.bundleNo]), [[1, "a", null], [2, "b", 1], [3, "c", 1], [4, "d", null], [5, "e", 2], [6, "f", 2]]);
  assert.deepEqual(findGroup(groups, "Pi")!.rows.map((r) => [r.no, r.record.id, r.bundleNo]), [[7, "p", 3], [8, "q", 3]]);
  assert.deepEqual(findGroup(groups, "交接单专区")!.rows.map((r) => [r.no, r.record.id]), [[9, "h"]]);
  assert.deepEqual(findGroup(groups, "待定")!.rows.map((r) => [r.no, r.record.id]), [[10, "i"], [11, "g"]]);
  assert.equal(findGroup(groups, "Pi")!.name, "Pi Agent", "只写开头也认");
  assert.equal(findGroup(groups, "没这组"), null);
});

test("号码写法：7、07、7-9、7,8,9、7、8、9、捆2；写错了说清楚", () => {
  assert.deepEqual(parseShowSpec(["07", "9-10", "3,4、5"]), { items: [7, 9, 10, 3, 4, 5], bundles: [] });
  assert.deepEqual(parseShowSpec(["捆2"]), { items: [], bundles: [2] });
  assert.throws(() => parseShowSpec(["第七条"]), /看不懂/);
  assert.throws(() => parseShowSpec([]), /第几条/);
});

test("只列标题：不吐原文、不吐 id，有小标题用小标题，捆先列一行，状态带上", () => {
  const text = formatBrief(groups, names, "Claude");
  assert.match(text, /号码全板统一/);
  assert.match(text, /【Claude】6 条/);
  assert.match(text, /01 小标题A/);
  assert.match(text, /捆1 捆一的名字（2 条）/);
  assert.match(text, /捆2 小标题E（2 条）/, "没起名的捆拿第一条的小标题顶着");
  assert.match(text, /03 捆一第二条  ♻️ Claude-3 在干/);
  assert.match(text, /04 第四条  ✅ 干完待审/);
  assert.doesNotMatch(text, /第一条原文/);
  assert.doesNotMatch(text, /\ba\b.*id/);
  assert.match(formatBrief(groups, names, "Pi"), /捆3 Pi 捆里第一条（2 条）[\s\S]*07 Pi 捆里第一条/);
  assert.match(formatBrief(groups, names, "没这组"), /没有叫「没这组」的组/);
});

test("点名读：不用写组名，只吐点到的几条，图换成路径说明，捆号吐整捆，号码不存在说清全板一共几条", () => {
  const show = formatShow(groups, names, "", parseShowSpec(["5", "捆1", "12"]), (t) => t.replace("[图片:image-x.png]", "\n[图片 1]\n"));
  assert.match(show, /【捆1 · Claude 组】捆一的名字（2 条：02 03）/);
  assert.match(show, /━━ 第 05 条 · Claude 组 · 捆2 · id e/);
  assert.match(show, /\[图片 1\]/);
  assert.doesNotMatch(show, /第一条原文|第四条/, "没点名的一个字不吐");
  assert.match(show, /看板上没有：第 12 条（全板一共 11 条）/);
  const handoff = formatShow(groups, names, "", parseShowSpec(["9"]), (t) => t);
  assert.match(handoff, /━━ 第 09 条 · 交接单 组 · 交接单 · id h/);
  assert.match(handoff, /详情：\n六块详情/);
  const pi = formatShow(groups, names, "", parseShowSpec(["捆3"]), (t) => t);
  assert.match(pi, /【捆3 · Pi Agent 组】/);
  // 多写了组名也照读，只是不在那组时提一句
  const wrong = formatShow(groups, names, "Claude", parseShowSpec(["10"]), (t) => t);
  assert.match(wrong, /━━ 第 10 条 · 待定 组/);
  assert.match(wrong, /这条在「待定」组，不在「Claude」组/);
  assert.throws(() => formatShow(groups, names, "没这组", parseShowSpec(["1"]), (t) => t), /没有叫/);
});

test("命令行：show 直接写号码（前面多写组名也认）；号码写错当场报", () => {
  assert.deepEqual(parseCliArgs(["show", "7-9", "捆2"]), { command: "show", group: "", spec: ["7-9", "捆2"], json: false, attach: [] });
  assert.deepEqual(parseCliArgs(["show", "Claude", "7"]), { command: "show", group: "Claude", spec: ["7"], json: false, attach: [] });
  assert.throws(() => parseCliArgs(["show"]), /后面要跟号码/);
  assert.throws(() => parseCliArgs(["show", "Claude"]), /后面要跟号码/);
  assert.throws(() => parseCliArgs(["show", "Claude", "七"]), /看不懂/);
});
