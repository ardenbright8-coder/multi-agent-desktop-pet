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
      : permissionExplanation(event, interaction, permission.irreversible),
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

// 权限说明（2026-11-04 他嫌满屏英文命令看不懂，学 clawd-on-desk）：
// 第一行「要干啥」用干活的 AI 自己写的那句说明（Claude 的 description），没有再用 action；
// 第二行才是原命令，长路径只留最后一层文件夹名。
function permissionExplanation(event: AgentEvent, interaction: InteractionPayload, irreversible: boolean): string {
  const resources = interaction.resources?.length
    ? interaction.resources.join("、")
    : event.paths?.length ? event.paths.join("、") : event.target || "";
  const meaningful = (text: string) => Boolean(text) && text !== resources && text !== event.target && text !== event.tool;
  const summary = (event.summary || "").trim();
  const action = (interaction.action || "").trim();
  const parts: string[] = [];
  if (meaningful(summary)) parts.push(sentence(`要干啥：${summary}`));
  // 别家 Agent 的 action 本身就是一句人话（Claude 的只是工具名，会被上面筛掉）
  if (meaningful(action) && action !== summary) parts.push(sentence(meaningful(summary) ? `具体：${action}` : `要干啥：${action}`));
  if (event.reason && event.reason.trim()) parts.push(sentence(`为什么：${event.reason.trim()}`));
  if (interaction.impact) parts.push(sentence(interaction.impact));
  if (irreversible) parts.push("⚠️ 这一步可能改不回来，看清再点。");
  if (interaction.rollback) parts.push(sentence(interaction.rollback));
  if (interaction.unknowns) parts.push(sentence(`仍未核实：${interaction.unknowns}`));
  const head = parts.join("") || sentence(`要用 ${event.tool || "一个工具"}，没写要干啥`);
  return resources ? `${head}\n原命令：${shortenPaths(resources)}` : head;
}

/** 命令里的长路径只留最后一层：C:\Users\嘉楷\…\permtest\repo → …\repo */
export function shortenPaths(text: string): string {
  return text.replace(/[A-Za-z]:[\\/](?:[^\\/'"\s;|]+[\\/])+([^\\/'"\s;|]+)/g, "…\\$1");
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
