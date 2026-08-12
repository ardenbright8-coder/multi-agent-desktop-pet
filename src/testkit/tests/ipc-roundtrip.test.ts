import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHub } from "../../events/hub";
import { LocalIpcClient } from "../../channel/ipc-client";
import { LocalIpcServer } from "../../channel/ipc-server";
import { discoveryPath } from "../../shared/paths";
import type { AgentEvent } from "../../shared/protocol";

test("named pipe roundtrip publishes, indexes and discovers after startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-hub-test-"));
  const previous = process.env.AGENT_PET_HUB_HOME;
  process.env.AGENT_PET_HUB_HOME = root;
  const hub = new AgentHub(join(root, "data", "events.ndjson"), {
    running: false,
    endpoint: "",
    discoveryPath: discoveryPath(),
    ownerPid: process.pid,
    protocolVersion: 1,
  });
  const server = new LocalIpcServer(hub);
  try {
    const discovery = await server.start();
    hub.updateServerInfo({ running: true, endpoint: discovery.endpoint });
    const client = new LocalIpcClient();
    const event: AgentEvent = {
      version: 1,
      eventId: randomUUID(),
      sourceInstance: "roundtrip-test",
      sequence: 1,
      emittedAt: Date.now(),
      agent: "opencode",
      sessionId: "roundtrip-session",
      kind: "state.working",
      project: "连接测试",
      summary: "命名管道实时索引",
    };
    const result = await client.publish(event) as { accepted: boolean };
    assert.equal(result.accepted, true);
    const hits = await client.search({ text: "命名管道" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].event.eventId, event.eventId);
    await assert.rejects(() => client.request("search.query", { text: 1 }));
    const health = await client.request("hello") as { healthy: boolean };
    assert.equal(health.healthy, true);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.AGENT_PET_HUB_HOME;
    else process.env.AGENT_PET_HUB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
