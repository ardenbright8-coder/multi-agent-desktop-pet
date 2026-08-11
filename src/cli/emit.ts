import { randomBytes, randomUUID } from "node:crypto";
import type { AgentEvent, EventKind } from "../shared/protocol";
import { LocalIpcClient } from "../main/ipc-client";

const args = parseArgs(process.argv.slice(2));
const agent = args.agent || "custom";
const sessionId = args.session || `${agent}-default`;
const kind = (args.kind || "state.working") as EventKind;
const event: AgentEvent = {
  version: 1,
  eventId: randomUUID(),
  sourceInstance: `${agent}:${process.pid}:${randomBytes(5).toString("hex")}`,
  sequence: Number(args.sequence || Date.now()),
  emittedAt: Date.now(),
  agent,
  sessionId,
  kind,
  project: args.project,
  cwd: args.cwd,
  title: args.title,
  summary: args.summary,
  reason: args.reason,
  tool: args.tool,
  target: args.target,
  requestId: args.request,
};

new LocalIpcClient().publish(event)
  .then(() => process.stdout.write("{}\n"))
  .catch(() => {
    // Hooks must remain fail-open for status reporting.
    process.stdout.write("{}\n");
  });

function parseArgs(values: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}
