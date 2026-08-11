import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentEvent } from "../shared/protocol";

test("protocol keeps ordered question options and response metadata", () => {
  const event = normalizeAgentEvent({
    version: 1,
    eventId: "question-event",
    sourceInstance: "provider-instance",
    sequence: 1,
    emittedAt: Date.now(),
    agent: "opencode",
    sessionId: "session-a",
    kind: "question.asked",
    requestId: "provider-question",
    interaction: {
      mode: "question",
      providerRequestId: "provider-question",
      prompts: [{
        id: "choice",
        question: "怎么处理？",
        options: [
          { id: "second", label: "第二种", description: "后执行" },
          { id: "first", label: "第一种", description: "先执行", recommended: true },
        ],
        multiple: false,
        allowCustomInput: true,
      }],
      recommendation: "第一种",
      responseCapability: true,
      responseStatus: "pending",
    },
  });
  assert.deepEqual(event?.interaction?.prompts[0].options.map((option) => option.id), ["second", "first"]);
  assert.equal(event?.interaction?.prompts[0].allowCustomInput, true);
  assert.equal(event?.interaction?.providerRequestId, "provider-question");
  assert.equal(event?.interaction?.responseCapability, true);
});

test("old interaction events remain valid but cannot fake a response", () => {
  const event = normalizeAgentEvent({
    version: 1,
    eventId: "legacy-permission",
    sourceInstance: "old-hook",
    sequence: 1,
    emittedAt: Date.now(),
    agent: "claude-code",
    sessionId: "legacy-session",
    kind: "permission.requested",
    requestId: "legacy-request",
    summary: "旧版权限事件",
  });
  assert.ok(event);
  assert.equal(event?.interaction, undefined);
});
