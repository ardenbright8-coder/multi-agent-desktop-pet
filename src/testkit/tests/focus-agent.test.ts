import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFocusProject, scoreAgentWindow } from "../../pet/focus-agent";

test("agent window scoring prefers the matching agent and ignores the pet itself", () => {
  assert.ok(scoreAgentWindow({ title: "OpenCode — 资源库", processName: "OpenCode", agent: "opencode", project: "资源库" }) >= 10);
  assert.ok(scoreAgentWindow({ title: "claude · 资源库", processName: "WindowsTerminal", agent: "claude-code" }) >= 10);
  assert.ok(scoreAgentWindow({ title: "Grok", processName: "grok", agent: "grok" }) >= 10);
  assert.ok(scoreAgentWindow({ title: "Thinking - Agent", processName: "grok", agent: "grok" }) >= 10);
  assert.ok(scoreAgentWindow({ title: "续枝 · Grok CLI 会话面板", processName: "pwsh", agent: "grok" }) < 0);
  assert.ok(scoreAgentWindow({ title: "Grok 4.6 Agentic Enhancements - Grok - Tabbit", processName: "Tabbit Browser", agent: "grok" }) < 0);
  assert.equal(scoreAgentWindow({ title: "多Agent桌面宠物", processName: "多Agent桌面宠物", agent: "opencode" }), -1);
  assert.ok(scoreAgentWindow({ title: "随便一个记事本", processName: "notepad", agent: "opencode" }) < 10);
});

test("配置目录名（如 config / .gemini）不当项目名去误伤无关终端，Antigravity 进程优先命中", () => {
  assert.equal(normalizeFocusProject("config", "antigravity"), "");
  assert.equal(normalizeFocusProject(".gemini", "antigravity"), "");
  assert.equal(normalizeFocusProject("0016_多Agent桌面宠物", "antigravity"), "0016_多Agent桌面宠物");
  assert.equal(
    scoreAgentWindow({ title: "Windows PowerShell - config", processName: "powershell", agent: "antigravity", project: "config" }),
    0,
  );
  assert.ok(
    scoreAgentWindow({ title: "随便一个文件 - Antigravity", processName: "Antigravity", agent: "antigravity", project: "config" }) >= 22,
  );
});
