import type { AgentEvent, PermissionExplanation, RiskLevel } from "../shared/protocol";

const HIGH_RISK = [
  /\brm\s+-rf\b/i,
  /\bremove-item\b.*-recurse/i,
  /\bdel(?:ete)?\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\s]*[fdx]/i,
  /\brd\s+\/s\s+\/q\b/i,
  /\bshutdown\s+\/(?:s|r)\b/i,
  /\bforce\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\breg(?:edit|\s+add|\s+delete)\b/i,
  /c:\\windows/i,
  /c:\\program files/i,
];

const WRITE_TOOLS = /edit|write|patch|bash|shell|command|exec|delete|move|rename/i;

export function explainPermission(event: AgentEvent): PermissionExplanation {
  const tool = event.tool || "未知工具";
  const target = event.target || event.paths?.join("、") || extractMetadataTarget(event.metadata) || "未提供目标";
  const combined = `${tool}\n${target}\n${event.summary || ""}\n${event.reason || ""}`;
  const inferredRisk = inferRisk(combined, tool);
  const risk = event.risk && event.risk !== "unknown" ? event.risk : inferredRisk;
  const irreversible = HIGH_RISK.some((pattern) => pattern.test(combined));

  return {
    heading: `${agentLabel(event.agent)} 需要你处理`,
    doing: event.summary || event.title || "Agent 正在继续当前任务",
    request: describeRequest(tool, target),
    reason: event.reason || reasonFromTool(tool),
    impact: impactFrom(tool, target, irreversible),
    risk,
    irreversible,
  };
}

function agentLabel(agent: string): string {
  const labels: Record<string, string> = {
    opencode: "OpenCode",
    "claude-code": "Claude Code",
    pi: "Pi",
    hermes: "Hermes",
    simulator: "模拟 Agent",
  };
  return labels[agent] || agent;
}

function extractMetadataTarget(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  for (const key of ["filePath", "path", "command", "url", "query", "pattern"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 1000);
  }
  return undefined;
}

function describeRequest(tool: string, target: string): string {
  if (/read|glob|grep|search/i.test(tool)) return `读取或检索：${target}`;
  if (/edit|write|patch/i.test(tool)) return `写入或修改：${target}`;
  if (/bash|shell|command|exec/i.test(tool)) return `执行命令：${target}`;
  if (/question|clarify/i.test(tool)) return `等待回答：${target}`;
  return `使用 ${tool}：${target}`;
}

function reasonFromTool(tool: string): string {
  if (/read|glob|grep|search/i.test(tool)) return "需要取得任务所需的信息后才能继续。";
  if (/edit|write|patch/i.test(tool)) return "需要把当前方案落实到文件中。";
  if (/bash|shell|command|exec/i.test(tool)) return "需要运行本机命令完成或验证当前步骤。";
  return "Agent 没有提供完整原因，建议回到原窗口核对。";
}

function impactFrom(tool: string, target: string, irreversible: boolean): string {
  if (irreversible) return `可能产生不可逆影响；目标为 ${target}`;
  if (/read|glob|grep|search/i.test(tool)) return `只读取 ${target}，正常情况下不改内容。`;
  if (/edit|write|patch/i.test(tool)) return `会改动 ${target}；有 Git 时可回退。`;
  if (/bash|shell|command|exec/i.test(tool)) return `命令作用范围取决于参数；当前目标为 ${target}`;
  return `影响目标：${target}`;
}

function inferRisk(combined: string, tool: string): RiskLevel {
  if (HIGH_RISK.some((pattern) => pattern.test(combined))) return "high";
  if (/bash|shell|command|exec/i.test(tool)) return "unknown";
  if (WRITE_TOOLS.test(tool)) return "medium";
  if (/read|glob|grep|search/i.test(tool)) return "low";
  return "unknown";
}
