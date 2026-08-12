// 冒烟自测：命名管道能通、事件写得进去、中文索引搜得到。

import { join } from "node:path";
import { app } from "electron";
import { LocalIpcClient } from "../channel/ipc-client";
import type { AgentHub } from "../events/hub";
import { makeSimulationEvent } from "../events/simulation";
import { writeJsonAtomic } from "../shared/atomic-file";
import { appDataRoot } from "../shared/paths";

export async function runSmokeTest(hub: AgentHub): Promise<void> {
  const client = new LocalIpcClient();
  await client.request("hello");
  await client.publish(makeSimulationEvent("state.working"));
  await client.publish(makeSimulationEvent("permission.requested"));
  const hits = await client.search({ text: "实时索引", limit: 10 });
  const snapshot = hub.snapshot();
  if (hits.length < 1 || snapshot.eventCount < 2 || snapshot.sessions.length < 1) {
    throw new Error(`Smoke test failed: hits=${hits.length}, events=${snapshot.eventCount}, sessions=${snapshot.sessions.length}`);
  }
  writeJsonAtomic(join(appDataRoot(), "smoke-ok.json"), { version: app.getVersion(), events: snapshot.eventCount, hits: hits.length, transport: "named-pipe" });
  process.stdout.write(`SMOKE_OK events=${snapshot.eventCount} hits=${hits.length} endpoint=named-pipe\n`);
}
