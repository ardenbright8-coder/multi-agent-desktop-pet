import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHub } from "../../events/hub";
import { InteractionBroker } from "../../interaction/broker";
import type { InteractionResponseInput } from "../../shared/protocol";

const response: InteractionResponseInput = {
  eventId: "event-1",
  agent: "pi",
  sessionId: "session-1",
  providerRequestId: "request-1",
  answers: [{ promptId: "question-1", customText: "private answer text" }],
};

test("broker binds, submits once and removes response text after provider acknowledgement", async () => {
  const statuses: string[] = [];
  const broker = new InteractionBroker(() => true, (_input, status) => statuses.push(status), 1_000);
  const submission = broker.submit(response);
  const duplicate = await broker.submit(response);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(broker.claim({ eventId: "event-1", agent: "wrong", sessionId: "session-1", providerRequestId: "request-1" }), null);
  const claim = broker.claim(response);
  assert.equal(claim?.answers[0].customText, "private answer text");
  assert.equal(broker.complete(claim!.responseId, claim!.claimToken, true), true);
  assert.deepEqual(await submission, { ok: true, status: "submitted", message: "回答已交回 Agent。" });
  assert.equal(broker.claim(response), null);
  assert.deepEqual(statuses, ["submitting", "submitted"]);
});

test("broker reports provider failure without marking the response submitted", async () => {
  const statuses: string[] = [];
  const broker = new InteractionBroker(() => true, (_input, status) => statuses.push(status), 1_000);
  const submission = broker.submit({ ...response, eventId: "event-2" });
  const claim = broker.claim({ ...response, eventId: "event-2" });
  broker.complete(claim!.responseId, claim!.claimToken, false, "provider rejected the reply");
  const result = await submission;
  assert.equal(result.ok, false);
  assert.match(result.message, /provider rejected/);
  assert.deepEqual(statuses, ["submitting", "failed"]);
});

test("hub enforces source binding and never writes response text to the journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-response-test-"));
  const journal = join(root, "events.ndjson");
  try {
    const hub = new AgentHub(journal, { running: true, endpoint: "test", discoveryPath: "test", ownerPid: process.pid, protocolVersion: 1 });
    hub.publish({
      version: 1,
      eventId: "event-1",
      sourceInstance: "pi-instance",
      sequence: 1,
      emittedAt: Date.now(),
      agent: "pi",
      sessionId: "session-1",
      kind: "question.asked",
      requestId: "request-1",
      interaction: {
        mode: "question",
        providerRequestId: "request-1",
        prompts: [{ id: "question-1", question: "回答？", options: [], multiple: false, allowCustomInput: true }],
        responseCapability: true,
        responseStatus: "pending",
      },
    });
    const submission = hub.submitInteractionResponse(response);
    assert.equal(hub.claimInteractionResponse({ ...response, sourceInstance: "wrong" }), null);
    const claim = hub.claimInteractionResponse({ ...response, sourceInstance: "pi-instance" });
    assert.ok(claim);
    assert.equal(hub.completeInteractionResponse({ responseId: claim.responseId, claimToken: claim.claimToken, success: true }).completed, true);
    assert.equal((await submission).ok, true);
    assert.doesNotMatch(readFileSync(journal, "utf8"), /private answer text/);
    assert.equal(hub.snapshot().sessions[0].pendingInteraction, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
