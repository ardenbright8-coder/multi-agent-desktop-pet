// 板块与内存单测：进程叫什么、绿黄红怎么判、还能加几个板块、总览窗口自己不算。

import assert from "node:assert/strict";
import test from "node:test";
import { RED_MB, YELLOW_MB, describeProcess, levelOf, summarize, type ProcessSample } from "../../overview/metrics";

const MB = 1024;

function sample(pid: number, type: string, mb: number, extra: Partial<ProcessSample> = {}): ProcessSample {
  return { pid, type, privateKB: mb * MB, windowTitles: [], ...extra };
}

test("describeProcess：主控、画图帮手、联网帮手、窗口按标题换人话", () => {
  assert.equal(describeProcess(sample(1, "Browser", 1)).label, "主控");
  assert.equal(describeProcess(sample(2, "GPU", 1)).label, "画图帮手");
  assert.equal(describeProcess(sample(3, "Utility", 1, { serviceName: "network.mojom.NetworkService" })).label, "联网帮手");
  assert.equal(describeProcess(sample(4, "Tab", 1, { windowTitles: ["Agent 看板"] })).label, "窗口：Agent 看板");
  assert.equal(describeProcess(sample(5, "Tab", 1, { windowTitles: ["多Agent桌面宠物", "别的"] })).label, "窗口：桌宠画框、别的");
  assert.equal(describeProcess(sample(6, "Utility", 1, { serviceName: "audio" })).label, "其他帮手");
});

test("levelOf：黄线以下绿，红线以上红", () => {
  assert.equal(levelOf(YELLOW_MB - 1), "绿");
  assert.equal(levelOf(YELLOW_MB), "黄");
  assert.equal(levelOf(RED_MB), "红");
});

test("summarize：合计、从大到小排、跳过总览窗口自己、算还能加几个", () => {
  const result = summarize([sample(1, "Browser", 100), sample(2, "GPU", 200), sample(9, "Tab", 50)], [9]);
  assert.equal(result.totalMB, 300);
  assert.deepEqual(result.rows.map((row) => row.pid), [2, 1]);
  assert.equal(result.level, "绿");
  assert.equal(result.roomMB, YELLOW_MB - 300);
  assert.equal(result.roomBackground, Math.floor((YELLOW_MB - 300) / 15));
  assert.equal(result.roomWindow, Math.floor((YELLOW_MB - 300) / 80));
  const over = summarize([sample(1, "Browser", YELLOW_MB + 10)]);
  assert.equal(over.roomMB, 0);
  assert.equal(over.roomWindow, 0);
});
