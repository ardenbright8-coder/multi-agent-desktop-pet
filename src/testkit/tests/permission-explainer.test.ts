import assert from "node:assert/strict";
import test from "node:test";
import { explainPermission } from "../../interaction/permission-explainer";
import { normalizeAgentEvent } from "../../shared/protocol";

test("dangerous Windows command is marked high risk and irreversible", () => {
  const explanation = explainPermission({
    version: 1,
    eventId: "danger-1",
    sourceInstance: "test",
    sequence: 1,
    emittedAt: Date.now(),
    agent: "opencode",
    sessionId: "session",
    kind: "permission.requested",
    summary: "准备清理系统目录",
    tool: "bash",
    target: "Remove-Item -Recurse C:\\Windows",
  });
  assert.equal(explanation.risk, "high");
  assert.equal(explanation.irreversible, true);
  assert.match(explanation.impact, /不可逆/);
});

test("metadata sanitizer redacts secret-like fields", () => {
  const normalized = normalizeAgentEvent({
    version: 1,
    eventId: "safe-1",
    sourceInstance: "test",
    sequence: 1,
    emittedAt: Date.now(),
    agent: "opencode",
    sessionId: "session",
    kind: "state.working",
    metadata: { apiKey: "do-not-store", filePath: "src/app.ts" },
  });
  assert.equal(normalized?.metadata?.apiKey, "[已遮盖]");
  assert.equal(normalized?.metadata?.filePath, "src/app.ts");
});
