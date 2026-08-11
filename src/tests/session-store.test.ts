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

test("permission creates a complete explanation and completion clears it", () => {
  const store = new SessionStore();
  const base = Date.now();
  store.apply({
    ...event(1, base, "permission.requested"),
    summary: "正在实现事件索引",
    reason: "需要把搜索逻辑写进工程",
    tool: "apply_patch",
    target: "src/main/event-index.ts",
    requestId: "permission-1",
  });
  const waiting = store.snapshot(1).sessions[0];
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.pendingPermission?.doing, "正在实现事件索引");
  assert.match(waiting.pendingPermission?.request || "", /event-index\.ts/);
  store.apply(event(2, base + 10, "task.completed"));
  assert.equal(store.snapshot(2).sessions[0].pendingPermission, undefined);
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
