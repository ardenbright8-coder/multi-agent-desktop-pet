import assert from "node:assert/strict";
import test from "node:test";
import { presentInteraction } from "../main/interaction-presenter";
import type { AgentEvent } from "../shared/protocol";

test("question presenter gives situation, cause, recommendation and impact without tautology", () => {
  const presentation = presentInteraction(baseEvent("question.asked", {
    summary: "正在决定长内容怎么展示",
    reason: "底部操作在长内容里可能滚出窗口",
    interaction: {
      mode: "question",
      title: "长内容怎么滚动？",
      providerRequestId: "question-1",
      prompts: [{
        id: "layout",
        question: "选哪种布局？",
        options: [{ id: "sticky", label: "固定底部", description: "正文单独滚动" }],
        multiple: false,
        allowCustomInput: true,
      }],
      recommendation: "固定底部，操作始终可用",
      impact: "只改变面板布局",
      responseCapability: true,
      responseStatus: "pending",
    },
  }));
  assert.equal(presentation.mode, "question");
  assert.equal(presentation.title, "长内容怎么滚动？");
  assert.match(presentation.explanation, /底部操作在长内容里可能滚出窗口/);
  assert.match(presentation.explanation, /固定底部/);
  assert.match(presentation.explanation, /只改变面板布局/);
  assert.doesNotMatch(presentation.explanation, /需要回答才能继续/);
});

test("permission presenter names exact action, resources and unknown rollback", () => {
  const presentation = presentInteraction(baseEvent("permission.requested", {
    reason: "需要把新逻辑写进源码",
    tool: "apply_patch",
    target: "src/main/hub.ts",
    interaction: {
      mode: "permission",
      title: "允许修改回传模块吗？",
      providerRequestId: "permission-1",
      prompts: [{ id: "permission", question: "允许吗？", options: [{ id: "once", label: "允许一次" }], multiple: false, allowCustomInput: false }],
      action: "修改回传模块",
      resources: ["src/main/hub.ts"],
      impact: "会改动一个源码文件",
      responseCapability: true,
      responseStatus: "pending",
    },
  }));
  assert.equal(presentation.mode, "permission");
  assert.match(presentation.explanation, /修改回传模块/);
  assert.match(presentation.explanation, /src\/main\/hub\.ts/);
  assert.match(presentation.explanation, /能否回退还没核实/);
});

function baseEvent(kind: AgentEvent["kind"], overrides: Partial<AgentEvent>): AgentEvent {
  return {
    version: 1,
    eventId: "event-1",
    sourceInstance: "source-1",
    sequence: 1,
    emittedAt: Date.now(),
    agent: "opencode",
    sessionId: "session-1",
    kind,
    summary: "正在处理当前任务",
    ...overrides,
  };
}
