import assert from "node:assert/strict";
import test from "node:test";
import { scoreAgentWindow } from "../../pet/focus-agent";

test("agent window scoring prefers the matching agent and ignores the pet itself", () => {
  assert.ok(scoreAgentWindow({ title: "OpenCode — 资源库", processName: "OpenCode", agent: "opencode", project: "资源库" }) >= 10);
  assert.ok(scoreAgentWindow({ title: "claude · 资源库", processName: "WindowsTerminal", agent: "claude-code" }) >= 10);
  assert.equal(scoreAgentWindow({ title: "多Agent桌面宠物", processName: "多Agent桌面宠物", agent: "opencode" }), -1);
  assert.ok(scoreAgentWindow({ title: "随便一个记事本", processName: "notepad", agent: "opencode" }) < 10);
});
