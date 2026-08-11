import type { AgentEvent, InteractionPayload, InteractionPresentation } from "../shared/protocol";
import { explainPermission } from "./permission-explainer";

export function presentInteraction(event: AgentEvent): InteractionPresentation {
  const mode = event.kind === "question.asked" ? "question" : "permission";
  const interaction = event.interaction || fallbackInteraction(event, mode);
  const permission = explainPermission(event);
  return {
    eventId: event.eventId,
    mode,
    title: interaction.title || directTitle(event, mode),
    explanation: mode === "question"
      ? questionExplanation(event, interaction)
      : permissionExplanation(event, interaction, permission.impact),
    providerRequestId: interaction.providerRequestId || event.requestId,
    prompts: interaction.prompts,
    recommendation: interaction.recommendation,
    responseCapability: interaction.responseCapability && Boolean(interaction.providerRequestId || event.requestId),
    responseStatus: interaction.responseStatus,
    risk: mode === "permission" ? permission.risk : event.risk || "unknown",
  };
}

function fallbackInteraction(event: AgentEvent, mode: "question" | "permission"): InteractionPayload {
  const question = event.target || event.reason || event.summary || "Agent 没有提供问题原文";
  return {
    mode,
    providerRequestId: event.requestId,
    prompts: mode === "question" ? [{ id: "question-1", question, options: [], multiple: false, allowCustomInput: false }] : [],
    responseCapability: false,
    responseStatus: "pending",
  };
}

function directTitle(event: AgentEvent, mode: "question" | "permission"): string {
  if (event.title && !/会话$/.test(event.title)) return event.title;
  const firstQuestion = event.interaction?.prompts[0]?.question;
  if (mode === "question") return firstQuestion || "请决定下一步怎么做";
  return event.summary || `是否允许 ${event.tool || "当前操作"}`;
}

function questionExplanation(event: AgentEvent, interaction: InteractionPayload): string {
  const situation = sentence(event.summary || event.title || "Agent 正在处理当前任务");
  const cause = sentence(event.reason || "当前事件没有说明走到这一步的具体原因，原因还没核实");
  const recommendation = interaction.recommendation
    ? sentence(`建议：${interaction.recommendation}`)
    : "Agent 没有给出明确推荐。";
  const differences = optionDifference(interaction);
  const impact = sentence(interaction.impact || "不同选择会改变 Agent 接下来采用的做法，除此之外的影响还没核实");
  return `${situation}${cause}${recommendation}${differences}${impact}请按下面 Agent 给出的原选项选择，也可以在支持时自己输入。`;
}

function permissionExplanation(event: AgentEvent, interaction: InteractionPayload, inferredImpact: string): string {
  const situation = sentence(event.summary || event.title || "Agent 正在处理当前任务");
  const reason = sentence(event.reason || "Agent 没有说明为什么需要这项权限，原因还没核实");
  const action = interaction.action || event.tool || "未提供具体操作";
  const resources = interaction.resources?.length
    ? interaction.resources.join("、")
    : event.paths?.length ? event.paths.join("、") : event.target || "未提供作用范围";
  const scope = sentence(`这次权限只覆盖“${action}”，涉及 ${resources}`);
  const impact = sentence(interaction.impact || inferredImpact || "负面影响还没核实");
  const rollback = sentence(interaction.rollback || "能否回退还没核实");
  const unknowns = interaction.unknowns ? sentence(`仍未核实：${interaction.unknowns}`) : "";
  return `${situation}${reason}${scope}${impact}${rollback}${unknowns}你从下面选择这次要给的权限就行。`;
}

function optionDifference(interaction: InteractionPayload): string {
  const described = interaction.prompts.flatMap((prompt) => prompt.options)
    .filter((option) => option.description)
    .slice(0, 3)
    .map((option) => `${option.label}是${option.description}`);
  return described.length ? sentence(`选项区别：${described.join("；")}`) : "选项差别以 Agent 原文为准。";
}

function sentence(value: string): string {
  const clean = value.trim();
  if (!clean) return "";
  return /[。！？；]$/.test(clean) ? clean : `${clean}。`;
}
