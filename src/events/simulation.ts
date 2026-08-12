// 本地模拟事件生成器。
// 这不只是测试用的：托盘菜单「发一条测试通知」和面板上的模拟按钮都是产品功能，走的就是这儿，
// 所以它住在 events 里，不在 testkit 里。

import { randomUUID } from "node:crypto";
import type { AgentEvent, EventKind } from "../shared/protocol";

let simulatorSequence = 0;

export function makeSimulationEvent(kind?: EventKind): AgentEvent {
  const kinds: EventKind[] = ["state.thinking", "state.working", "question.asked", "permission.requested", "task.completed", "task.failed"];
  const selected = kind && kinds.includes(kind) ? kind : kinds[simulatorSequence % kinds.length];
  simulatorSequence += 1;
  const isPermission = selected === "permission.requested";
  const isQuestion = selected === "question.asked";
  const requestId = isPermission || isQuestion ? randomUUID() : undefined;
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: "desktop-simulator",
    sequence: simulatorSequence,
    emittedAt: Date.now(),
    agent: "simulator",
    sessionId: "demo-session",
    kind: selected,
    project: "多 Agent 桌面宠物",
    title: "验证统一通知链路",
    summary: isPermission ? "准备修改事件索引并运行验证" : isQuestion ? "正在确定长内容在面板里的呈现方式" : stateSummary(selected),
    reason: isPermission ? "现有索引缺少交互状态，需要写入模块才能完成这次实现" : isQuestion ? "长说明必须保持可读，同时底部操作不能被滚出窗口" : "这是一条本地模拟事件",
    tool: isPermission ? "apply_patch" : selected === "state.working" ? "test" : isQuestion ? "question" : undefined,
    target: isPermission ? "src/events/event-index.ts" : isQuestion ? "面板内容较长时采用哪种布局" : undefined,
    paths: isPermission ? ["src/events/event-index.ts"] : undefined,
    requestId,
    interaction: isPermission ? {
      mode: "permission",
      title: "允许修改事件索引并运行测试吗？",
      providerRequestId: requestId,
      prompts: [{
        id: "permission",
        question: "请选择这次权限范围",
        multiple: false,
        allowCustomInput: false,
        options: [
          { id: "once", label: "允许一次", value: "once", description: "只执行当前这次修改和验证", recommended: true },
          { id: "reject", label: "拒绝", value: "reject", description: "不执行，Agent 返回原窗口等待" },
        ],
      }],
      recommendation: "允许一次，范围只覆盖列出的文件和测试",
      action: "修改文件并运行项目测试",
      resources: ["src/events/event-index.ts", "项目测试命令"],
      impact: "会改动一个源码文件并启动本地测试进程，不删除文件。",
      rollback: "源码有 Git 时可以回退；测试进程结束后不常驻。",
      unknowns: "测试耗时还没核实",
      responseCapability: true,
      responseStatus: "pending",
    } : isQuestion ? {
      mode: "question",
      title: "长内容应该怎么滚动？",
      providerRequestId: requestId,
      prompts: [{
        id: "layout",
        question: "面板内容超过一屏时，操作区应该放在哪里？",
        multiple: false,
        allowCustomInput: true,
        options: [
          { id: "sticky", label: "固定底部操作", value: "固定底部操作", description: "正文单独滚动，关闭和确认始终可用", recommended: true },
          { id: "all-scroll", label: "整页一起滚动", value: "整页一起滚动", description: "结构简单，但长内容时要滚到底才能操作" },
        ],
      }],
      recommendation: "固定底部操作，长说明只在正文区域滚动",
      impact: "只影响面板布局和操作可达性，不改 Agent 原始选项。",
      responseCapability: true,
      responseStatus: "pending",
    } : undefined,
  };
}

function stateSummary(kind: EventKind): string {
  const labels: Partial<Record<EventKind, string>> = {
    "state.thinking": "正在理解任务和安排步骤",
    "state.working": "正在执行工具和验证结果",
    "task.completed": "任务已经完成，可以回来查看",
    "task.failed": "任务遇到错误，需要回来处理",
  };
  return labels[kind] || "状态发生变化";
}
