// multi-agent-desktop-pet managed Pi extension v1
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export default function agentPetPiExtension(pi: any) {
  pi.on("session_start", async (event: any, ctx: any) => report(ctx, "session.started", { summary: `Pi 会话已经开始（${event.reason || "startup"}）` }));
  pi.on("before_agent_start", async (event: any, ctx: any) => report(ctx, "state.thinking", { summary: "Pi 正在理解任务", prompt: event.prompt }));
  pi.on("tool_execution_start", async (event: any, ctx: any) => report(ctx, "state.working", {
    summary: `正在使用 ${event.toolName || "工具"}`,
    tool_name: event.toolName,
    tool_input: event.args,
    tool_use_id: event.toolCallId,
  }));
  pi.on("tool_execution_end", async (event: any, ctx: any) => report(ctx, event.isError ? "task.failed" : "state.working", {
    summary: event.isError ? `${event.toolName || "工具"}执行失败` : `已完成 ${event.toolName || "工具"}，继续处理任务`,
    reason: event.isError ? "Pi 工具执行失败" : undefined,
    tool_name: event.toolName,
    tool_input: event.args,
    tool_use_id: event.toolCallId,
  }));
  pi.on("agent_settled", async (_event: any, ctx: any) => report(ctx, "task.completed", { summary: "Pi 已经完成这一轮任务" }));
  pi.on("session_shutdown", async (event: any, ctx: any) => report(ctx, "session.ended", { summary: `Pi 会话已经结束（${event.reason || "quit"}）` }));
}

function report(ctx: any, kind: string, details: Record<string, unknown>) {
  try {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const bridge = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
    const sessionId = ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.() || "pi-default";
    const payload = {
      ...details,
      session_id: sessionId,
      cwd: ctx?.cwd || process.cwd(),
      title: "Pi 会话",
    };
    const child = spawn(process.execPath, [bridge, "pi", kind], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch {
    // Status reporting must never affect Pi.
  }
}
