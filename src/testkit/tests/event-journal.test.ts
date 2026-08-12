import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventJournal } from "../../events/event-journal";
import type { AgentEvent } from "../../shared/protocol";

test("journal truncates a partial crash tail before appending the next event", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-journal-"));
  const path = join(root, "events.ndjson");
  const first = event("first", 1);
  writeFileSync(path, `${JSON.stringify(first)}\n{"eventId":"partial"`, "utf8");
  try {
    const journal = new EventJournal(path);
    assert.equal(journal.load().length, 1);
    journal.append(event("third", 3));
    const reloaded = new EventJournal(path).load();
    assert.deepEqual(reloaded.map((item) => item.eventId), ["first", "third"]);
    assert.match(readFileSync(`${path}.corrupt.ndjson`, "utf8"), /partial/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function event(eventId: string, sequence: number): AgentEvent {
  return {
    version: 1,
    eventId,
    sourceInstance: "journal-test",
    sequence,
    emittedAt: Date.now() + sequence,
    agent: "opencode",
    sessionId: "journal-session",
    kind: "state.working",
    summary: eventId,
  };
}
