// 手机同步看板单测（2026-09-24 设定19）：电脑把整板抄一份发到中转站，手机打开就拉最新一份；
// 手机上挪组、删条（含早上审完「可以，删掉」）发回电脑执行。期望答案都在这里手写。

import assert from "node:assert/strict";
import test from "node:test";
import { applyPhoneOp, buildBoardSnapshot, parsePhoneOp, type BoardRow } from "../../bookmark/board-sync";

const rows: BoardRow[] = [
  { id: "a", text: "甲", assignee: "Claude", kind: "note", detail: null, bundleId: null, claimedBy: "Claude-3", report: null, reportedBy: null, reportedAt: null, dedupeKey: null, createdAt: "2026-09-24T01:00:00.000Z", url: null, attachments: [] },
  { id: "b", text: "乙[图片:image-1.png]", assignee: null, kind: "note", detail: null, bundleId: null, claimedBy: null, report: null, reportedBy: null, reportedAt: null, dedupeKey: "k-1", createdAt: "2026-09-24T02:00:00.000Z", url: "https://x.y", attachments: ["image-1.png"] },
  { id: "c", text: "交接：干到一半", assignee: null, kind: "handoff", detail: "下一步改手机", bundleId: null, claimedBy: null, report: "好了", reportedBy: "Claude-2", reportedAt: "2026-09-24T03:00:00.000Z", dedupeKey: null, createdAt: "2026-09-24T03:00:00.000Z", url: null, attachments: [] },
];

test("buildBoardSnapshot：带版本、档位、分组名单、条目按看板顺序；只带手机要看的字段，不带本机图片路径", () => {
  const snap = buildBoardSnapshot(rows, ["Claude", "Pi Agent"], "sleep", 1_700_000_000_000);
  assert.equal(snap.v, 1);
  assert.equal(snap.type, "board");
  assert.equal(snap.ts, 1_700_000_000_000);
  assert.equal(snap.mode, "sleep");
  assert.deepEqual(snap.agents, ["Claude", "Pi Agent"]);
  assert.deepEqual(snap.items.map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(snap.items[0], {
    id: "a", text: "甲", assignee: "Claude", kind: "note", detail: null, bundleId: null,
    claimedBy: "Claude-3", report: null, reportedBy: null, reportedAt: null, dedupeKey: null, url: null, images: 0,
  });
  assert.equal(snap.items[1].images, 1);
  assert.equal(snap.items[1].dedupeKey, "k-1", "手机靠它认出哪条是自己发的、已经进看板了");
  assert.equal(snap.items[2].report, "好了");
  assert.equal(JSON.stringify(snap).includes("attachments"), false);
});

test("parsePhoneOp：只认 assign / delete 两种，缺 id 不认；别的类型（note、cmd）不是命令", () => {
  assert.deepEqual(parsePhoneOp({ type: "op", op: "assign", id: "a", assignee: "Hermes" }), { op: "assign", id: "a", assignee: "Hermes" });
  assert.deepEqual(parsePhoneOp({ type: "op", op: "assign", id: "a", assignee: "" }), { op: "assign", id: "a", assignee: null }, "空＝挪回待定");
  assert.deepEqual(parsePhoneOp({ type: "op", op: "delete", id: "b" }), { op: "delete", id: "b" });
  assert.equal(parsePhoneOp({ type: "op", op: "rm -rf", id: "b" }), null);
  assert.equal(parsePhoneOp({ type: "op", op: "delete" }), null);
  assert.equal(parsePhoneOp({ type: "cmd", op: "delete", id: "b" }), null, "cmd 只入库绝不执行（手机端约定）");
  assert.equal(parsePhoneOp({ type: "note", content: "x" }), null);
});

test("applyPhoneOp：挪组走 setAssignee、删走 remove；条目不在了不报错只说没找到", () => {
  const calls: string[] = [];
  const store = {
    list: () => rows,
    setAssignee: (id: string, a: string | null) => { calls.push(`assign ${id} ${a}`); return null; },
    remove: (id: string) => { calls.push(`remove ${id}`); return true; },
  };
  assert.equal(applyPhoneOp(store, { op: "assign", id: "a", assignee: "Hermes" }), "把「甲」挪到 Hermes");
  assert.equal(applyPhoneOp(store, { op: "assign", id: "b", assignee: null }), "把「乙[图片:image-1.png]」挪回待定");
  assert.equal(applyPhoneOp(store, { op: "delete", id: "c" }), "删掉「交接：干到一半」");
  assert.equal(applyPhoneOp(store, { op: "delete", id: "zz" }), "要删的那条已经不在了");
  assert.deepEqual(calls, ["assign a Hermes", "assign b null", "remove c"]);
});
