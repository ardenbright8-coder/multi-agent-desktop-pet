import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../main/session-store";
import type { AgentEvent, EventKind } from "../shared/protocol";

test("session store rejects duplicate sequence and late state regression", () => {
  const store = new SessionStore();
  const base = Date.now();
  assert.equal(store.apply(event(1, base, "state.working")), "accepted");
  assert.equal(store.apply(event(1, base + 1, "state.working")), "stale");
  assert.equal(store.apply(event(2, base + 10_000, "task.completed")), "accepted");
  assert.equal(store.apply(event(3, base + 1_000, "state.working")), "stale");
  assert.equal(store.snapshot(2).sessions[0].state, "done");
});

test("permission creates a structured presentation and completion clears it", () => {
  const store = new SessionStore();
  const base = Date.now();
  store.apply({
    ...event(1, base, "permission.requested"),
    summary: "正在实现事件索引",
    reason: "需要把搜索逻辑写进工程",
    tool: "apply_patch",
    target: "src/main/event-index.ts",
    requestId: "permission-1",
    interaction: {
      mode: "permission",
      providerRequestId: "permission-1",
      prompts: [{
        id: "permission",
        question: "请选择权限范围",
        options: [{ id: "once", label: "允许一次", value: "once" }, { id: "reject", label: "拒绝", value: "reject" }],
        multiple: false,
        allowCustomInput: false,
      }],
      action: "修改文件",
      resources: ["src/main/event-index.ts"],
      responseCapability: true,
      responseStatus: "pending",
    },
  });
  const waiting = store.snapshot(1).sessions[0];
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.pendingInteraction?.mode, "permission");
  assert.equal(waiting.pendingInteraction?.prompts[0].options[0].label, "允许一次");
  assert.match(waiting.pendingInteraction?.explanation || "", /event-index\.ts/);
  store.apply(event(2, base + 10, "task.completed"));
  assert.equal(store.snapshot(2).sessions[0].pendingInteraction, undefined);
});

test("question and permission stay distinct in renderer snapshots", () => {
  const store = new SessionStore();
  const base = Date.now();
  store.apply({
    ...event(1, base, "question.asked"),
    requestId: "question-1",
    target: "选择布局",
    interaction: {
      mode: "question",
      providerRequestId: "question-1",
      prompts: [{
        id: "layout",
        question: "选择哪种布局？",
        options: [{ id: "fixed", label: "固定操作区", value: "固定操作区" }],
        multiple: false,
        allowCustomInput: true,
      }],
      recommendation: "固定操作区",
      responseCapability: true,
      responseStatus: "pending",
    },
  });
  const question = store.snapshot(1).sessions[0].pendingInteraction;
  assert.equal(question?.mode, "question");
  assert.equal(question?.prompts[0].allowCustomInput, true);

  store.apply({
    ...event(2, base + 1, "permission.requested"),
    requestId: "permission-2",
    interaction: {
      mode: "permission",
      providerRequestId: "permission-2",
      prompts: [{ id: "permission", question: "允许吗？", options: [{ id: "once", label: "允许一次" }], multiple: false, allowCustomInput: false }],
      responseCapability: false,
      responseStatus: "pending",
    },
  });
  const permission = store.snapshot(2).sessions[0].pendingInteraction;
  assert.equal(permission?.mode, "permission");
  assert.equal(permission?.responseCapability, false);
});

test("pending interaction survives incidental thinking and working telemetry", () => {
  const store = new SessionStore();
  const base = Date.now();
  store.apply({
    ...event(1, base, "question.asked"),
    requestId: "question-1",
    interaction: {
      mode: "question",
      providerRequestId: "question-1",
      prompts: [{ id: "choice", question: "选哪个？", options: [{ id: "a", label: "A" }], multiple: false, allowCustomInput: false }],
      responseCapability: true,
      responseStatus: "pending",
    },
  });
  store.apply({ ...event(1, base + 1, "state.working"), sourceInstance: "hook-source" });
  store.apply({ ...event(2, base + 2, "state.thinking"), sourceInstance: "hook-source" });
  const snapshot = store.snapshot(3).sessions[0];
  assert.equal(snapshot.state, "waiting");
  assert.equal(snapshot.pendingInteraction?.providerRequestId, "question-1");
});

test("foreign completion, failure and mismatched resolution cannot dismiss a pending interaction", () => {
  const store = new SessionStore();
  const base = Date.now();
  store.apply({
    ...event(1, base, "permission.requested"),
    sourceInstance: "interactive-source",
    requestId: "permission-1",
    interaction: {
      mode: "permission",
      providerRequestId: "permission-1",
      prompts: [{ id: "permission", question: "允许吗？", options: [{ id: "once", label: "允许一次" }], multiple: false, allowCustomInput: false }],
      responseCapability: true,
      responseStatus: "pending",
    },
  });
  store.apply({ ...event(1, base + 1, "task.completed"), sourceInstance: "telemetry-source" });
  store.apply({ ...event(2, base + 2, "task.failed"), sourceInstance: "telemetry-source" });
  store.apply({ ...event(3, base + 3, "permission.resolved"), sourceInstance: "telemetry-source", requestId: "other-request" });
  const snapshot = store.snapshot(4).sessions[0];
  assert.equal(snapshot.state, "waiting");
  assert.equal(snapshot.pendingInteraction?.providerRequestId, "permission-1");
});

test("matching resolution and same-source terminal state dismiss pending interactions", () => {
  const store = new SessionStore();
  const base = Date.now();
  const asked = {
    ...event(1, base, "question.asked" as const),
    sourceInstance: "interactive-source",
    requestId: "question-1",
    interaction: {
      mode: "question" as const,
      providerRequestId: "question-1",
      prompts: [{ id: "choice", question: "选哪个？", options: [{ id: "a", label: "A" }], multiple: false, allowCustomInput: false }],
      responseCapability: true,
      responseStatus: "pending" as const,
    },
  };
  store.apply(asked);
  store.apply({ ...event(2, base + 1, "question.resolved"), sourceInstance: "interactive-source", requestId: "question-1" });
  assert.equal(store.snapshot(2).sessions[0].pendingInteraction, undefined);
  assert.equal(store.snapshot(2).sessions[0].state, "working");

  store.apply({ ...asked, eventId: "question-2-event", sequence: 3, emittedAt: base + 2, requestId: "question-2", interaction: { ...asked.interaction, providerRequestId: "question-2" } });
  store.apply({ ...event(4, base + 3, "task.completed"), sourceInstance: "interactive-source" });
  assert.equal(store.snapshot(4).sessions[0].pendingInteraction, undefined);
  assert.equal(store.snapshot(4).sessions[0].state, "done");
});

test("late session end cannot delete a newer live session", () => {
  const store = new SessionStore();
  const base = Date.now();
  assert.equal(store.apply(event(10, base + 10_000, "state.working")), "accepted");
  assert.equal(store.apply(event(5, base + 5_000, "session.ended")), "stale");
  assert.equal(store.snapshot(1).sessions[0].state, "working");
});

test("session priority follows needs-input, blocked, ready, running", () => {
  const store = new SessionStore();
  const base = Date.now();
  store.apply({ ...event(1, base, "state.working"), sessionId: "running" });
  store.apply({ ...event(1, base + 1, "task.completed"), sessionId: "ready" });
  store.apply({ ...event(1, base + 2, "task.failed"), sessionId: "blocked" });
  store.apply({ ...event(1, base + 3, "permission.requested"), sessionId: "needs-input", requestId: "approval" });
  const snapshot = store.snapshot(4);
  assert.deepEqual(snapshot.sessions.map((session) => session.state), ["waiting", "error", "done", "working"]);
  assert.equal(snapshot.topState, "waiting");
});

function event(sequence: number, emittedAt: number, kind: EventKind): AgentEvent {
  return {
    version: 1,
    eventId: `event-${sequence}-${emittedAt}`,
    sourceInstance: "source-a",
    sequence,
    emittedAt,
    agent: "opencode",
    sessionId: "session-a",
    kind,
    project: "测试项目",
    summary: "测试状态",
  };
}
