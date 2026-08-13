import assert from "node:assert/strict";
import test from "node:test";
import { createTurnGate } from "./multi-agent-desktop-pet.mjs";

test("one turn only publishes completion once", () => {
  const gate = createTurnGate();
  gate.start("s1");
  assert.equal(gate.canComplete("s1"), true);
  gate.markCompleted("s1");
  assert.equal(gate.canComplete("s1"), false);
});

test("idle after a failure does not become a completion", () => {
  const gate = createTurnGate();
  gate.start("s1");
  gate.markFailed("s1");
  assert.equal(gate.canComplete("s1"), false);
});

test("new work after a completed turn can complete again", () => {
  const gate = createTurnGate();
  gate.start("s1");
  gate.markCompleted("s1");
  gate.start("s1");
  assert.equal(gate.canComplete("s1"), true);
});

test("chat-only turn with no tools still completes on first idle", () => {
  const gate = createTurnGate();
  assert.equal(gate.canComplete("fresh"), true);
});
