import assert from "node:assert/strict";
import test from "node:test";
import { EventIndex, multilingualTokenize } from "../main/event-index";
import type { AgentEvent } from "../shared/protocol";

test("CJK tokenizer emits unigram and bigram tokens", () => {
  const tokens = multilingualTokenize("实时索引 OpenCode src/event-index.ts");
  assert(tokens.includes("实"));
  assert(tokens.includes("实时"));
  assert(tokens.includes("索引"));
  assert(tokens.includes("opencode"));
  assert(tokens.includes("event"));
});

test("real-time index finds Chinese summary and exact target path", () => {
  const index = new EventIndex();
  const event: AgentEvent = {
    version: 1,
    eventId: "event-1",
    sourceInstance: "test-source",
    sequence: 1,
    emittedAt: Date.now(),
    agent: "opencode",
    sessionId: "session-1",
    kind: "permission.requested",
    project: "多Agent桌面宠物",
    title: "实现实时索引",
    summary: "需要索引到指定内容并马上返回",
    reason: "用户需要按中文关键词定位事件",
    tool: "apply_patch",
    target: "src/main/event-index.ts",
    paths: ["src/main/event-index.ts"],
  };
  index.add(event);
  assert.equal(index.search({ text: "实时索引" }).length, 1);
  assert.equal(index.search({ text: "指定内容" }).length, 1);
  assert.equal(index.search({ text: "实时内容索引" }).length, 1);
  assert.equal(index.search({ text: "event-index" }).length, 1);
  assert.equal(index.search({ text: "不存在的内容" }).length, 0);
});
