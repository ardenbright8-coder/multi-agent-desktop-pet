// multi-agent-desktop-pet managed generic hook bridge v1
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const APP_ID = "multi-agent-desktop-pet";
const PROTOCOL_VERSION = 1;
// 对照 Clawd permission.js：回传只有 once / always / reject。
// 自己填对照 bubble-renderer.js 的 Other 文本框；写 yes/允许/同意 就当放行。
const ALLOW_WORDS = new Set(["yes", "y", "ok", "okay", "是", "好", "行", "可以", "允许", "同意", "确认", "准", "放行"]);
const ALWAYS_WORDS = new Set(["always", "一直允许", "以后都允许", "不再问", "都允许"]);
const REJECT_WORDS = new Set(["no", "n", "deny", "reject", "不", "拒绝", "不准", "不行"]);
const ALLOW_PREFIXES = ["好", "行", "可以", "允许", "同意", "确认", "放行", "没问题", "嗯", "ok", "yes"];
// 带这些就是有条件、有转折，不能当同意：原话交给 Claude 自己看
const TURN_WORDS = /不|别|但|先等|等等|等一下|停|拒|no|don'?t|but|wait/;
// ═══ 什么算"大权限"：命中这张表的，桌宠弹窗不给「以后都允许」，每次都问 ═══
// 标准：碰 Windows 系统那一摊、改网络配置、不可逆、或者往外发。
// 2026-10-31 起 Claude 终端里要你确认的一律弹桌宠（他：每次回窗口点太浪费时间），这张表只管能不能记住。
// 想加想减就改这张表，改完跑 `node agent-pet-hook.mjs --self-test` 确认没写错。
// ⚠️ 必须放在文件顶部：脚本一进来就调 shouldGateThroughPet()，const 不会提升，
//    放在文件中段会报 "Cannot access 'BIG_DEAL' before initialization"，
//    而且这个错会被 failOpen 静默吞掉 —— 表现就是"桌宠死活不弹"，很难查。
const BIG_DEAL = [
  // 删东西 / 清空
  /\brm\s+-[a-z]*[rf]/i, /Remove-Item[^\n]*-Recurse/i, /\brmdir\s+\/s/i, /\bdel\s+\/[qsf]/i,
  // 磁盘 / 引导 / 分区
  /Format-Volume/i, /Clear-Disk/i, /\bdiskpart\b/i, /\bbcdedit\b/i, /\bmkfs\b/i,
  // 注册表 / 服务 / 账户 / 权限
  /reg\s+delete/i, /\bsc\s+delete/i, /\bnet\s+user\b/i, /\btakeown\b/i, /\bicacls\b/i,
  /Set-ExecutionPolicy/i, /New-LocalUser/i,
  // 关机重启
  /\bshutdown\b/i, /Restart-Computer/i, /Stop-Computer/i,
  // 往外发（推出去就收不回来了）
  /git\s+push/i, /npm\s+publish/i, /\bgh\s+(pr|release)\s+create/i,
  // Windows 系统那一摊
  /C:[\\/]+Windows[\\/]/i, /C:[\\/]+Program Files/i, /C:[\\/]+ProgramData/i, /System32/i,
  // 网络配置那一摊（Clash / mihomo / VMISS 网关 / VPS）
  /mihomo|clash|verge/i, /mine\.yaml|sister\.yaml|backup\.yaml/i,
  /proxy-groups|nameserver-policy|\bsubscri/i, /\bssh\s+\S/i, /vmiss|gateway/i,
];

const EVENT_KINDS = new Set([
  "session.started", "context.updated", "state.thinking", "state.working",
  "permission.requested", "permission.resolved", "question.asked", "question.resolved",
  "task.completed", "task.failed", "session.ended", "heartbeat",
]);

process.on("uncaughtException", (error) => {
  failOpen(error);
});
process.on("unhandledRejection", (error) => {
  failOpen(error);
});

const argv = process.argv.slice(2);
if (argv[0] === "--self-test") {
  process.exit(runSelfTest() ? 0 : 1);
}
if (argv[0] === "--watch-pending") {
  await watchPendingPermission(argv[1]);
  process.exit(0);
}

const [agentArg = "generic", hookArg = "context.updated"] = argv;
let leftNote = ""; // 桌宠「自己输入」里写的、不是同意／拒绝的那段话

function antigravityDefaultOutput(hook) {
  return String(hook || "").toLowerCase().includes("pretooluse") ? '{"decision":"allow"}\n' : "{}\n";
}

// 桌宠没起来就别耗着——照 app 自带原版的做法：连不上，静默走人，零输出（Antigravity 按契约回空 JSON）。
// 不加这行的话 publish() 会硬撑重试，然后 failOpen 吐一段 CC 不认的 JSON，
// 结果就是启动慢 10 秒 + 每次回答后打印一整张 schema。
if (!existsSync(discoveryPath())) {
  if (agentArg === "antigravity") process.stdout.write(antigravityDefaultOutput(hookArg));
  process.exit(0);
}

try {
  if (argv[0] === "--live-gate") {
    await runLiveGate(argv.slice(1).join(" ").trim());
  } else {
    const input = await readInput();
    const agent = detectAgent(agentArg, input);
    // 留个底：把权限请求的原始 payload 存下来，字段名对不上时好查。
    if (String(hookArg || "").toLowerCase().includes("permissionrequest")) {
      try {
        const dir = hubDataDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "last-permission-payload.json"), JSON.stringify(input, null, 2), "utf8");
      } catch { /* 存不下也不能挡 */ }
    }
    if (shouldGateThroughPet(hookArg, input, agent)) {
      writeHookDecision(agent, await gateThroughPet(agent, hookArg, input), input);
    } else if (String(hookArg || "").toLowerCase().includes("permissionrequest")) {
      // 不走网关的权限请求（AskUserQuestion 这类桌宠答不了的）：连报都不报。
      // 不加这条的话，它会掉进上报路径 → 桌宠照样弹一个"不支持回传，请回终端"的窗，等于白弹一次。
      process.exit(0);
    } else if (agent === "claude-code" && isPermissionNotification(hookArg, input)) {
      // Claude 的权限提醒：PermissionRequest 那边已经弹了可点的窗，这里再报就弹第二个点不了的。
      process.exit(0);
    } else {
      const event = translate(agent, hookArg, input);
      if (event) await publish(event);
      await resolveAnsweredInTerminal(agent, hookArg, input);
      if (agent === "antigravity") process.stdout.write(antigravityDefaultOutput(hookArg));
    }
  }
} catch (error) {
  failOpen(error);
}

function detectAgent(requested, _input) {
  // Grok 会顺手跑 Claude 的 hook 文件；GROK_* 环境变量是 Grok 注入的，用来把来源标对。
  if (process.env.GROK_SESSION_ID || process.env.GROK_HOOK_EVENT || process.env.GROK_WORKSPACE_ROOT) return "grok";
  return requested;
}

function hubRoot() {
  if (process.env.AGENT_PET_HUB_HOME) return process.env.AGENT_PET_HUB_HOME;
  if (process.env.AGENT_PET_ISOLATED !== "1") {
    try {
      const parent = join(import.meta.dirname, "..");
      if (basename(import.meta.dirname) === "integrations" && (existsSync(join(parent, "runtime")) || existsSync(join(parent, "data")))) {
        return parent;
      }
      if (existsSync("F:\\应用数据\\AgentPetHub")) return "F:\\应用数据\\AgentPetHub";
    } catch { /* ignore */ }
  }
  return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "AgentPetHub");
}

function discoveryPath() {
  return join(hubRoot(), "runtime", "ipc.json");
}

async function readInput() {
  if (process.stdin.isTTY) return {};
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 256 * 1024) return {};
  }
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { return { message: body.slice(0, 2_000) }; }
}

function translate(agent, hook, input) {
  const normalizedAgent = clean(agent, 80) || "generic";
  const normalizedHook = String(hook || "").toLowerCase();
  const directKind = EVENT_KINDS.has(hook) ? hook : null;
  const kind = directKind || kindFromHook(normalizedHook, input);
  if (!kind) return null;

  const cwd = firstString(
    input.cwd,
    input.workspaceRoot,
    Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined,
    input.working_directory,
    input.project_dir,
    process.env.GROK_WORKSPACE_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd(),
  );
  const sessionId = firstString(input.session_id, input.sessionId, input.conversation_id, input.conversationId, input.task_id, process.env.GROK_SESSION_ID, `${normalizedAgent}-default`);
  const tool = firstString(input.tool_name, input.toolName, input.tool, input.toolCall?.name, input.name);
  const toolInput = objectValue(input.tool_input, input.toolInput, input.toolCall?.args, input.input, input.arguments);
  const target = targetFrom(toolInput, input);
  const reason = firstString(
    input.reason,
    input.message,
    input.error?.message,
    typeof input.error === "string" ? input.error : undefined,
    reasonFromHook(normalizedAgent, normalizedHook, tool),
  );
  const requestId = firstString(input.request_id, input.requestId, input.tool_use_id, input.toolUseId, input.id);
  const summary = firstString(input.summary, input.title, summaryFromHook(normalizedAgent, normalizedHook, tool));
  const interaction = interactionFrom(kind, input, toolInput, requestId, tool);
  const emittedAt = Date.now();

  const event = {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: `${normalizedAgent}-hook:${process.pid}:${randomBytes(5).toString("hex")}`,
    sequence: 1,
    emittedAt,
    agent: normalizedAgent,
    sessionId: clean(sessionId, 200) || `${normalizedAgent}-default`,
    kind,
    project: cwd ? basename(cwd) : normalizedAgent,
    cwd: clean(cwd, 1_000),
    title: clean(firstString(input.session_title, input.title, `${agentLabel(normalizedAgent)} 会话`), 500),
    summary: clean(summary, 2_000),
    reason: clean(reason, 2_000),
    tool: clean(tool, 120),
    target: clean(target, 2_000),
    paths: pathList(toolInput, input),
    requestId: clean(requestId, 200),
    originPid: Number(process.ppid) > 0 ? Number(process.ppid) : process.pid,
    interaction,
    metadata: safeMetadata(toolInput),
  };
  if (normalizedHook.includes("notification") && isPlanNotification(input)) {
    event.title = `${agentLabel(normalizedAgent)} 在等你批计划`;
    event.summary = "这是终端里的计划批准，幼苗点不了 a。回终端按 a 批准，或按 s 要改。";
    event.reason = "Grok 自己的计划窗没有回传通道，幼苗只能提醒你。";
    event.interaction = {
      mode: "permission",
      title: "回终端批计划",
      providerRequestId: event.requestId || randomUUID(),
      prompts: [{
        id: "plan",
        question: "幼苗批不了这扇窗。回终端按 a 批准。",
        multiple: false,
        allowCustomInput: false,
        options: [{ id: "goto", label: "知道了，回终端", value: "goto" }],
      }],
      responseCapability: false,
      responseStatus: "pending",
    };
  }
  return event;
}

function interactionFrom(kind, input, toolInput, requestId, tool) {
  if (kind !== "question.asked" && kind !== "permission.requested") return undefined;
  const mode = kind === "question.asked" ? "question" : "permission";
  const sources = [input, toolInput].filter((value) => value && typeof value === "object");
  const rawQuestions = sources.find((source) => Array.isArray(source.questions))?.questions;
  const questions = Array.isArray(rawQuestions) && rawQuestions.length ? rawQuestions : [sources.find((source) => firstString(source.question, source.prompt, source.message)) || {}];
  const prompts = questions.map((question, index) => {
    const rawOptions = Array.isArray(question.options)
      ? question.options
      : Array.isArray(question.choices) ? question.choices : index === 0 ? firstArray(sources, "options", "choices") : [];
    return {
      id: clean(firstString(question.id, question.key), 120) || `question-${index + 1}`,
      question: clean(firstString(question.question, question.prompt, question.text, question.message, input.question, input.prompt, "Agent 没有提供问题原文"), 1_500),
      options: rawOptions.map((option, optionIndex) => normalizeInteractionOption(option, optionIndex)).filter(Boolean),
      multiple: question.multiple === true || question.multiSelect === true,
      allowCustomInput: question.custom === true || question.allowCustomInput === true || input.custom === true || input.allowCustomInput === true,
    };
  });
  const resources = firstArray(sources, "resources", "paths").map((value) => clean(String(value), 1_000)).filter(Boolean);
  return {
    mode,
    title: clean(firstString(input.interaction_title, input.header, input.title, prompts[0]?.question), 500),
    providerRequestId: clean(requestId, 200),
    prompts: mode === "question" ? prompts : prompts.map((prompt) => ({ ...prompt, question: prompt.question || "请选择权限范围" })),
    recommendation: clean(firstString(input.recommendation, toolInput.recommendation), 1_000),
    action: mode === "permission" ? clean(firstString(input.action, input.permission, tool), 1_000) : undefined,
    resources,
    impact: clean(firstString(input.impact, toolInput.impact), 1_500),
    rollback: clean(firstString(input.rollback, toolInput.rollback), 1_000),
    unknowns: clean(firstString(input.unknowns, toolInput.unknowns), 1_000),
    responseCapability: false,
    responseStatus: "pending",
  };
}

function normalizeInteractionOption(option, index) {
  if (typeof option === "string") return { id: `option-${index + 1}`, label: clean(option, 300), value: clean(option, 500) };
  if (!option || typeof option !== "object") return null;
  const label = clean(firstString(option.label, option.value, option.text, option.name), 300);
  if (!label) return null;
  return {
    id: clean(firstString(option.id, option.key), 120) || `option-${index + 1}`,
    label,
    value: clean(firstString(option.value, option.label, option.text), 500) || label,
    description: clean(firstString(option.description, option.hint), 1_000),
    recommended: option.recommended === true,
  };
}

function firstArray(sources, ...keys) {
  for (const source of sources) for (const key of keys) if (Array.isArray(source?.[key])) return source[key];
  return [];
}

function kindFromHook(hook, input) {
  if (hook.includes("permission")) return hook.includes("resolved") ? "permission.resolved" : "permission.requested";
  if (hook.includes("elicitation") || hook.includes("question")) return hook.includes("resolved") || hook.includes("replied") ? "question.resolved" : "question.asked";
  if (hook.includes("sessionend") || hook.includes("session.end") || hook === "end") return "session.ended";
  if (hook.includes("sessionstart") || hook.includes("session.start") || hook === "start") return "session.started";
  if (hook.includes("stopfailure") || hook.includes("toolusefailure") || hook.includes("tool.error") || hook.includes("failed")) return "task.failed";
  if (hook.includes("posttool") && input.error) return "task.failed";
  if (hook === "stop" || hook.includes("task.completed") || hook.includes("complete")) {
    const term = String(input.terminationReason || "").toUpperCase();
    if (term === "ERROR") return "task.failed";
    if (term === "USER_CANCELED") return "session.ended";
    const reason = String(input.reason || input.stopReason || "").toLowerCase();
    if (reason && reason !== "end_turn") return "session.ended";
    return "task.completed";
  }
  if (hook.includes("pretool") || hook.includes("posttool") || hook.includes("tool.") || hook.includes("subagent")) return "state.working";
  if (hook.includes("prompt") || hook.includes("preinvocation") || hook.includes("thinking")) return "state.thinking";
  if (hook.includes("notification")) {
    const notification = notificationText(input);
    if (notification.includes("plan") || notification.includes("approval") || notification.includes("permission") || notification.includes("input")) {
      return "permission.requested";
    }
    if (notification.includes("idle") || notification.includes("complete") || notification.includes("task")) return "task.completed";
    return "context.updated";
  }
  if (hook.includes("heartbeat")) return "heartbeat";
  return "context.updated";
}

function notificationText(input) {
  return String(input.notification_type || input.notificationType || input.type || input.message || input.title || "").toLowerCase();
}

function isPlanNotification(input) {
  const text = notificationText(input);
  return text.includes("plan") || text.includes("approval");
}

function summaryFromHook(agent, hook, tool) {
  const label = agentLabel(agent);
  if (hook.includes("sessionstart")) return `${label} 会话已经开始`;
  if (hook.includes("prompt") || hook.includes("preinvocation")) return `${label} 正在理解任务`;
  if (hook.includes("pretool")) return `正在使用 ${tool || "工具"}`;
  if (hook.includes("posttool")) return `已完成 ${tool || "工具"}，继续处理任务`;
  if (hook.includes("permission")) return `${label} 需要你处理权限`;
  if (hook.includes("elicitation") || hook.includes("question")) return `${label} 正在等你回答`;
  if (hook === "stop") return `${label} 已经完成这一轮任务`;
  if (hook.includes("failure") || hook.includes("failed")) return `${label} 遇到错误，需要回来查看`;
  if (hook.includes("sessionend")) return `${label} 会话已经结束`;
  return `${label} 状态已更新`;
}

function reasonFromHook(agent, hook, tool) {
  const label = agentLabel(agent);
  if (hook.includes("permission")) return `${label} 请求使用 ${tool || "当前工具"} 继续执行`;
  if (hook.includes("pretool")) return "正在执行当前任务所需的工具";
  if (hook.includes("failure") || hook.includes("failed")) return `${tool || "工具"} 执行失败`;
  return undefined;
}

function targetFrom(toolInput, input) {
  for (const source of [toolInput, input]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["file_path", "filePath", "path", "Path", "command", "CommandLine", "url", "query", "pattern", "prompt"]) {
      if (typeof source[key] === "string" && source[key].trim()) return source[key];
    }
  }
  return undefined;
}

function pathList(toolInput, input) {
  const values = [];
  for (const source of [toolInput, input]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["file_path", "filePath", "path"]) if (typeof source[key] === "string") values.push(clean(source[key], 1_000));
    if (Array.isArray(source.paths)) values.push(...source.paths.map((value) => clean(value, 1_000)));
  }
  const filtered = values.filter(Boolean).slice(0, 20);
  return filtered.length ? filtered : undefined;
}

function safeMetadata(input) {
  if (!input || typeof input !== "object") return undefined;
  const output = {};
  for (const key of ["file_path", "filePath", "path", "command", "url", "query", "pattern"]) {
    if (typeof input[key] === "string") output[key] = clean(input[key], 1_800);
  }
  return Object.keys(output).length ? output : undefined;
}

function objectValue(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function clean(value, max) {
  if (typeof value !== "string") return undefined;
  const redacted = value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'`,;]+/gi, "$1[已遮盖]")
    .replace(/\b(sk-[a-z0-9_-]{12,})\b/gi, "[已遮盖]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`,;]+/gi, "$1[已遮盖]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
  return redacted ? redacted.slice(0, max) : undefined;
}

function agentLabel(agent) {
  return ({ "claude-code": "Claude Code", opencode: "OpenCode", pi: "Pi", hermes: "Hermes", grok: "Grok", codex: "Codex", antigravity: "Antigravity" })[agent] || agent;
}

function hubDataDir() {
  return join(hubRoot(), "data");
}

function alwaysAllowPath() {
  return join(hubDataDir(), "always-allow.json");
}

function readAlwaysMap() {
  try {
    const data = JSON.parse(readFileSync(alwaysAllowPath(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function isAlwaysRemembered(agent) {
  return readAlwaysMap()[agent] === true;
}

function rememberAlways(agent) {
  const dir = hubDataDir();
  mkdirSync(dir, { recursive: true });
  const next = { ...readAlwaysMap(), [agent]: true };
  writeFileSync(alwaysAllowPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function normalizeDecisionText(value) {
  return String(value || "").trim().toLowerCase().replace(/[!！。.?？,，\s]/g, "");
}

function decideFromClaim(claim) {
  const answer = claim?.answers?.[0] || {};
  const option = String(answer.optionIds?.[0] || "").trim().toLowerCase();
  const text = normalizeDecisionText(answer.customText);
  if (option === "once") return "allow";
  if (option === "always") return "always";
  if (option === "reject") return "reject";
  if (ALWAYS_WORDS.has(text)) return "always";
  if (ALLOW_WORDS.has(text)) return "allow";
  if (REJECT_WORDS.has(text)) return "reject";
  // 他是语音输入，很少只说一个字：「好，没问题」开头是同意词、后面没转折，也算同意（2026-10-31）
  if (ALLOW_PREFIXES.some((word) => text.startsWith(word)) && !TURN_WORDS.test(text)) return "allow";
  return "reject";
}

function permissionPrompt(canRemember = true, alwaysDescription = "这家 Agent 先记住，先不问了") {
  const options = [
    { id: "once", label: "允许一次", value: "once", description: "只准这一次", recommended: true },
    { id: "always", label: "以后都允许", value: "always", description: alwaysDescription },
    { id: "reject", label: "拒绝", value: "reject", description: "这次不执行" },
  ];
  return {
    id: "permission",
    question: "点一个，或自己填。",
    multiple: false,
    allowCustomInput: true,
    options: canRemember ? options : options.filter((option) => option.id !== "always"),
  };
}

// CC 对不同事件收的字段不一样，写错一个字它就把整张 schema 打屏幕上。
//   PreToolUse       → hookSpecificOutput.permissionDecision（allow/deny/ask）
//   PermissionRequest→ hookSpecificOutput.decision.behavior（allow/deny），拒绝带 message
//   其它事件（含 Notification）→ 一个字都不能输出
// 顶层的 decision 字段只收 approve/block，之前那版写 "allow" 是非法的，就是报错的根。
// 2026-10-31：PermissionRequest 以前写成顶层 permissionDecision，CC 不认、也不报错，
// 桌宠上点的允许/拒绝全白点，CC 等钩子退了再回终端问。官方格式见 code.claude.com/docs/en/hooks。
function writeHookDecision(agent, decision, input = {}) {
  const permissionRequest = isBigDealGate(hookArg);
  // 记不住的（大事、CC 没给建议规则）：自己写 always 也只算这一次。
  if (decision === "always" && permissionRequest && !canRememberInClaude(input)) decision = "allow";
  // PermissionRequest 的「以后都允许」交给 CC 自己记（跟终端选 Yes, don't ask again 一样），不按整家 Agent 记。
  if (decision === "always" && !permissionRequest) rememberAlways(agent);
  const updatedPermissions = decision === "always" && permissionRequest ? input.permission_suggestions : undefined;
  const hook = String(hookArg || "").toLowerCase();
  if (agent === "antigravity") {
    if (decision === "timeout" || !hook.includes("pretooluse")) {
      process.stdout.write(antigravityDefaultOutput(hookArg));
      return;
    }
    const agReason = decision === "reject"
      ? (leftNote ? `用户在桌宠上没批准，留了话：「${leftNote}」` : "用户在桌宠上拒绝了这次操作")
      : undefined;
    process.stdout.write(`${JSON.stringify({ decision: decision === "reject" ? "deny" : "allow", ...(agReason ? { reason: agReason } : {}) })}\n`);
    return;
  }
  // 桌宠上没人点 → 不表态，交回给 CC 自己问。别替用户做主。
  if (decision === "timeout") return;
  const permissionDecision = decision === "reject" ? "deny" : "allow";
  // 自己输入的话不是同意／拒绝那几个词：当没批准，但原话交给 Claude 看（弹窗上写着「按你的原话交回 Agent」）
  const reason = decision === "reject"
    ? (leftNote ? `用户在桌宠上没批准，留了话：「${leftNote}」` : "用户在桌宠上拒绝了这次操作")
    : "用户在桌宠上放行了这次操作";

  if (hook.includes("pretooluse")) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: reason,
      },
    })}\n`);
    return;
  }
  if (hook.includes("permissionrequest")) {
    process.stdout.write(`${JSON.stringify(permissionRequestOutput(permissionDecision, reason, updatedPermissions))}\n`);
    return;
  }
  // Notification 之类的事件根本不接受决定，回传也没处使，闭嘴。
}

function permissionRequestOutput(permissionDecision, reason, updatedPermissions) {
  const decision = permissionDecision === "deny"
    ? { behavior: "deny", message: reason }
    : { behavior: "allow" };
  if (decision.behavior === "allow" && Array.isArray(updatedPermissions) && updatedPermissions.length) {
    decision.updatedPermissions = updatedPermissions;
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

// CC 给了「以后别问」的建议规则、又不是大事，桌宠才给「以后都允许」。
function canRememberInClaude(input) {
  return Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0 && !isBigDeal(input);
}

// ═══ 终端先答了，桌宠那个窗要收掉 ═══
// CC 终端的确认框和桌宠弹窗同时在，哪边先答算哪边。终端先答时钩子可能被 CC 掐掉，来不及报，
// 所以弹窗时留个记号（按 会话+工具+参数 算出固定号），之后这几种事件看到记号就报 permission.resolved：
//   PostToolUse / PostToolUseFailure：同一个工具同样参数跑了 → 那条已经答了
//   UserPromptSubmit / Stop / StopFailure / SessionEnd：这个会话往下走了 → 它名下的全收掉
function permissionKey(input) {
  const session = firstString(input.session_id, input.sessionId) || "";
  const tool = firstString(input.tool_name, input.toolName, input.tool) || "";
  const toolInput = objectValue(input.tool_input, input.toolInput, input.input);
  return `perm-${createHash("sha1").update(`${session}\n${tool}\n${stableJson(toolInput)}`).digest("hex").slice(0, 20)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pendingDir() {
  return join(hubDataDir(), "pending-permission");
}

function pendingFile(requestId) {
  return join(pendingDir(), `${requestId}.json`);
}

function isPending(requestId) {
  return Boolean(requestId) && existsSync(pendingFile(requestId));
}

function transcriptSize(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return -1;
  try {
    return statSync(transcriptPath).size;
  } catch {
    return -1;
  }
}

function answeredInTranscript(transcriptPath, startSize) {
  if (!transcriptPath || typeof transcriptPath !== "string" || startSize < 0) return false;
  try {
    const size = statSync(transcriptPath).size;
    if (size <= startSize) return false;
    const tail = readFileSync(transcriptPath).subarray(startSize).toString("utf8");
    for (const raw of tail.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && (entry.type === "user" || entry.type === "assistant")) return true;
      } catch { /* 写到一半的行跳过 */ }
    }
    return false;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function markPending(requestId, sessionId, extra = {}) {
  try {
    mkdirSync(pendingDir(), { recursive: true });
    writeFileSync(pendingFile(requestId), JSON.stringify({
      sessionId,
      at: Date.now(),
      ...extra,
    }), "utf8");
  } catch { /* 记号留不下也不能挡 */ }
}

function spawnPendingWatcher(requestId) {
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath || !requestId) return;
    spawn(process.execPath, [scriptPath, "--watch-pending", requestId], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch { /* 守护进程起不来也不挡主流程 */ }
}

async function watchPendingPermission(requestId) {
  if (!requestId || !isPending(requestId)) return;
  let mark;
  try {
    mark = JSON.parse(readFileSync(pendingFile(requestId), "utf8"));
  } catch {
    return;
  }
  const deadline = Date.now() + 125_000;
  while (Date.now() < deadline) {
    await delay(280);
    if (!isPending(requestId)) return;
    const pidDead = mark.pid ? !isPidAlive(mark.pid) : false;
    const transcriptMoved = answeredInTranscript(mark.transcriptPath, typeof mark.startSize === "number" ? mark.startSize : -1);
    if (pidDead || transcriptMoved) {
      if (clearPending(requestId)) {
        try { await publishResolved(mark.agent || "claude-code", mark.input || {}, requestId); } catch { /* ignore */ }
      }
      return;
    }
  }
}

function clearPending(requestId) {
  try { unlinkSync(pendingFile(requestId)); return true; } catch { return false; }
}

async function publishResolved(agent, input, requestId) {
  const event = translate(agent, "permission.resolved", { ...input, request_id: requestId, tool_use_id: undefined });
  if (event) await publish(event);
}

async function resolveAnsweredInTerminal(agent, hook, input) {
  const name = String(hook || "").toLowerCase();
  const sessionId = firstString(input.session_id, input.sessionId);
  if (!sessionId || !existsSync(pendingDir())) return;
  if (name.includes("posttooluse")) {
    const requestId = permissionKey(input);
    if (clearPending(requestId)) await publishResolved(agent, input, requestId);
    return;
  }
  if (!/pretooluse|userpromptsubmit|^stop|stopfailure|sessionend/.test(name)) return;
  for (const file of readdirSync(pendingDir())) {
    const path = join(pendingDir(), file);
    try {
      const mark = JSON.parse(readFileSync(path, "utf8"));
      const stale = Date.now() - statSync(path).mtimeMs > 6 * 60 * 60 * 1000;
      if (mark.sessionId !== sessionId && !stale) continue;
      unlinkSync(path);
      if (mark.sessionId === sessionId) await publishResolved(agent, input, file.replace(/\.json$/, ""));
    } catch { /* 坏记号跳过 */ }
  }
}

function isPermissionNotification(hook, input) {
  if (!String(hook || "").toLowerCase().includes("notification")) return false;
  const text = notificationText(input);
  return text.includes("permission") || text.includes("approval");
}

function failOpen(error) {
  try {
    const dir = hubDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hook-error.log"), `${new Date().toISOString()} ${error?.stack || error}\n`, "utf8");
  } catch { /* 记不住也不能挡 */ }
  // 出错时什么都别输出（Antigravity 按契约回空 JSON）。上报型钩子的任何 stdout 都会被 CC 当决定去校验，一校验就报错。
  if (agentArg === "antigravity") process.stdout.write(antigravityDefaultOutput(hookArg));
  process.exit(0);
}

function shouldGateThroughPet(hook, input, agent) {
  const name = String(hook || "").toLowerCase();
  if (name.includes("notification")) {
    // Claude 的权限走 PermissionRequest，这里只给 Grok 这类没有 PermissionRequest 的用。
    if (agent === "claude-code") return false;
    const text = notificationText(input);
    return text.includes("permission") || text.includes("plan") || text.includes("approval") || text.includes("input");
  }
  // PermissionRequest 是 CC 真要在终端问你了（不是每次调工具都来），一律走桌宠网关（可回传）。
  // 之前这里跟 PreToolUse 共用工具白名单，ExitPlanMode 这类工具名不匹配就掉进上报路径，
  // 上报路径的 responseCapability 写死 false → 桌宠只能显示"不支持回传，请回终端"。
  // 例外：AskUserQuestion 是 Claude 问你选择题，桌宠只有允许/拒绝，答不了，留在终端。
  if (name.includes("permissionrequest")) {
    return firstString(input.tool_name, input.toolName, input.tool) !== "AskUserQuestion";
  }
  if (agent === "antigravity" && name.includes("pretooluse")) {
    return input.petGate === true || isBigDeal(input);
  }
  // PreToolUse 不再走桌宠网关：它在 CC 还没决定要不要问你之前就触发，
  // 结果是每一次 Bash/Edit/Write 都要去桌宠上点一下，会话直接没法用。
  // CC 自己放行的照常飞过，等它真要问你时会发 PermissionRequest，那时才弹桌宠。
  return false;
}

function isBigDeal(input) {
  const bag = [];
  const eat = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") { bag.push(value); return; }
    if (Array.isArray(value)) { value.forEach((item) => eat(item, depth + 1)); return; }
    if (typeof value === "object") { Object.values(value).forEach((item) => eat(item, depth + 1)); }
  };
  eat(objectValue(input.tool_input, input.toolInput, input.toolCall?.args, input.input, input.arguments));
  eat(firstString(input.tool_name, input.toolName, input.tool, input.toolCall?.name));
  eat(firstString(input.message, input.reason, input.permission, input.action));
  const text = bag.join("\n").slice(0, 20_000);
  return BIG_DEAL.some((rule) => rule.test(text));
}

function replyGrokTerminal(decision) {
  // 终端如果还停在英文三选项，替用户按键。对照 Clawd 回传，不抄它的 FFI。
  const keys = decision === "reject" ? "{ESC}" : decision === "always" ? "1{ENTER}" : "2{ENTER}";
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -TypeDefinition @'",
    "using System; using System.Runtime.InteropServices;",
    "public static class AgentPetTui {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
    "}",
    "'@",
    "$p = Get-Process -Name grok,Grok -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if (-not $p) { exit 0 }",
    "[AgentPetTui]::ShowWindow($p.MainWindowHandle, 9) | Out-Null",
    "[AgentPetTui]::SetForegroundWindow($p.MainWindowHandle) | Out-Null",
    "Start-Sleep -Milliseconds 180",
    `[System.Windows.Forms.SendKeys]::SendWait('${keys}')`,
  ].join("; ");
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

function choiceLabel(decision, customText) {
  if (customText) return `你写了「${customText}」`;
  if (decision === "always") return "你选了「以后都允许」";
  if (decision === "allow") return "你选了「允许一次」";
  if (decision === "reject") return "你选了「拒绝」";
  return `结果是 ${decision}`;
}

function persistLastChoice(record) {
  const dir = hubDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "last-choice.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function announceChoice(agent, decision, extra = {}) {
  const customText = typeof extra.customText === "string" ? extra.customText.trim() : "";
  const picked = extra.alwaysRemembered
    ? `按你上次选的「以后都允许」，这次「${extra.tool || "操作"}」自动放行了`
    : choiceLabel(decision, extra.usedCustom ? customText : "");
  const summary = extra.alwaysRemembered
    ? `${picked}。要取消记住，把 always-allow 里的 grok 删掉，或下次在幼苗上改口。`
    : decision === "always"
      ? `${picked}，已经记住。下次会自动放行，并再弹一张回执给你看。`
      : decision === "allow"
        ? `${picked}，只这一次。`
        : `${picked}，这次没做。`;
  persistLastChoice({
    at: new Date().toISOString(),
    agent,
    decision,
    picked,
    customText: customText || undefined,
    tool: extra.tool,
    alwaysRemembered: extra.alwaysRemembered === true,
  });
  // 点完权限直接收窗，不再闪第二张「你选了允许一次」完成小提示（仅自动放行时弹回执）
  if (!extra.alwaysRemembered) return;
  try {
    await publish({
      version: 1,
      eventId: randomUUID(),
      sourceInstance: `${agent}-hook:${process.pid}:choice`,
      sequence: 1,
      emittedAt: Date.now(),
      agent,
      sessionId: `choice-${randomUUID()}`,
      kind: "task.completed",
      project: extra.project || agent,
      title: picked,
      summary,
      reason: picked,
      tool: extra.tool,
      originPid: Number(process.ppid) > 0 ? Number(process.ppid) : process.pid,
    });
  } catch { /* 回执弹不出来也不能挡决定 */ }
}

// PermissionRequest 不认 always-allow.json 那份按整家 Agent 的记忆：2026-10-31 之前点一次
// 就把 Claude Code 往后所有权限全放了，桌宠再也不弹。它的「以后都允许」交给 CC 自己记（见 writeHookDecision）。
function isBigDealGate(hook) {
  return String(hook || "").toLowerCase().includes("permissionrequest");
}

async function gateThroughPet(agent, hook, input) {
  const tool = firstString(input.tool_name, input.toolName, input.tool, input.toolCall?.name) || "命令";
  const permissionRequest = isBigDealGate(hook);
  if (!permissionRequest && isAlwaysRemembered(agent)) {
    await announceChoice(agent, "always", { alwaysRemembered: true, tool });
    return "always";
  }
  const canRemember = permissionRequest ? canRememberInClaude(input) : true;
  const alwaysDescription = permissionRequest
    ? "跟终端里选「Yes, and don't ask again」一样，这类以后不问"
    : undefined;
  const target = targetFrom(objectValue(input.tool_input, input.toolInput, input.toolCall?.args, input.input), input) || "未提供目标";
  const requestId = permissionRequest
    ? permissionKey(input)
    : firstString(input.request_id, input.requestId, input.tool_use_id, input.toolUseId, randomUUID());
  const sessionId = firstString(input.session_id, input.sessionId, input.conversationId, process.env.GROK_SESSION_ID, `${agent}-default`);
  const transcriptPath = firstString(input.transcript_path, input.transcriptPath);
  const startSize = transcriptSize(transcriptPath);
  if (permissionRequest) {
    markPending(requestId, sessionId, {
      pid: process.pid,
      agent,
      input: {
        session_id: sessionId,
        cwd: firstString(input.cwd, input.workspaceRoot, process.cwd()),
        tool_name: tool,
        tool_input: objectValue(input.tool_input, input.toolInput, input.input),
      },
      transcriptPath,
      startSize,
    });
  }
  const event = {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: `${agent}-hook:${process.pid}:${randomBytes(5).toString("hex")}`,
    sequence: 1,
    emittedAt: Date.now(),
    agent,
    sessionId: clean(sessionId, 200) || `${agent}-default`,
    kind: "permission.requested",
    project: basename(firstString(input.cwd, input.workspaceRoot, process.env.GROK_WORKSPACE_ROOT, process.cwd()) || agent),
    cwd: firstString(input.cwd, input.workspaceRoot, process.env.GROK_WORKSPACE_ROOT, process.cwd()),
    title: `${agentLabel(agent)} 要用 ${tool}`,
    summary: target && target !== "未提供目标" ? target : `是否允许使用 ${tool}？`,
    reason: "",
    tool,
    target,
    requestId,
    originPid: Number(process.ppid) > 0 ? Number(process.ppid) : process.pid,
    interaction: {
      mode: "permission",
      title: `允许 ${agentLabel(agent)} 使用 ${tool} 吗？`,
      providerRequestId: requestId,
      prompts: [permissionPrompt(canRemember, alwaysDescription)],
      action: tool,
      resources: [target],
      // impact / rollback / unknowns 三个字段桌宠会原样拼进说明里，
      // 拼出来就是"允许就会真的做这件事，拒绝就跳过。拒绝则什么都不改。仍未核实：无。"
      // 一堆废话，不传。
      responseCapability: true,
      responseStatus: "pending",
    },
  };
  await publish(event);
  if (permissionRequest) spawnPendingWatcher(requestId);
  // 等多久是个权衡：
  //   等太久 → 桌宠没人管时，CC 在这儿干站着；
  //   等太短 → 钩子先退了，你再点，桌宠那边永远卡在"正在交回…"（app 侧没有超时处理，
  //            它不知道对面已经没人了）。30 秒实测就短了，人还没走到跟前就超时。
  // 2 分钟（用户定的）：宁可多等，也别出现"点了没人接"。
  // ⚠️ 改这个数就得同步改 settings.json 里 PermissionRequest 那条钩子的 timeout，
  //    CC 的钩子超时默认 60 秒，比这个短的话 CC 会先把进程杀了，白设。
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (permissionRequest && (!isPending(requestId) || answeredInTranscript(transcriptPath, startSize))) {
      if (clearPending(requestId)) {
        try { await publishResolved(agent, input, requestId); } catch { /* ignore */ }
      }
      return "timeout";
    }
    let claim;
    try {
      claim = await sendRequest("interaction.response.claim", {
        eventId: event.eventId,
        agent: event.agent,
        sessionId: event.sessionId,
        providerRequestId: requestId,
        sourceInstance: event.sourceInstance,
      });
    } catch {
      await delay(400);
      continue;
    }
    if (!claim) {
      await delay(400);
      continue;
    }
    if (permissionRequest) clearPending(requestId);
    const decision = decideFromClaim(claim);
    const note = String(claim.answers?.[0]?.customText || "").trim();
    if (decision === "reject" && note && !REJECT_WORDS.has(normalizeDecisionText(note))) leftNote = clean(note, 2_000) || "";
    try {
      await sendRequest("interaction.response.complete", {
        responseId: claim.responseId,
        claimToken: claim.claimToken,
        success: true,
      });
    } catch { /* 交回结果以桌宠点的为准 */ }
    await announceChoice(agent, decision, {
      customText: claim.answers?.[0]?.customText,
      usedCustom: !(claim.answers?.[0]?.optionIds?.[0]),
      tool,
    });
    if (String(hook || "").toLowerCase().includes("notification")) replyGrokTerminal(decision);
    return decision;
  }
  // 没人点：把桌宠那个窗收掉，别留一个点了没人接的。
  if (permissionRequest && clearPending(requestId)) {
    try { await publishResolved(agent, input, requestId); } catch { /* 收不掉就等桌宠自己清 */ }
  }
  // 等超时了。原来这里直接返回 allow —— 等于"没人管就放行"，太危险。
  // 改成不表态：钩子什么都不输出，CC 回落到它自己的权限询问。
  return "timeout";
}

async function runLiveGate(reason) {
  const why = reason || "证明幼苗上点了或写了 yes 就算数";
  const decision = await gateThroughPet("grok", "pretooluse", {
    tool_name: "run_terminal_command",
    tool_input: { command: "notepad 桌宠已确认.txt" },
    session_id: process.env.GROK_SESSION_ID || "live-gate",
    cwd: process.cwd(),
    reason: why,
  });
  const dir = hubDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "live-gate-result.json"), `${JSON.stringify({
    decision,
    at: new Date().toISOString(),
    reason: why,
  }, null, 2)}\n`, "utf8");
  if (decision === "always") rememberAlways("grok");
  if (decision === "reject") {
    process.stdout.write("REJECT\n");
    return;
  }
  const txt = join(process.env.TEMP || dir, "桌宠已确认-可以继续.txt");
  writeFileSync(txt, `幼苗上已经放行（${decision}）。这次不是摆设。\n${why}\n`, "utf8");
  spawn("notepad.exe", [txt], { detached: true, stdio: "ignore" }).unref();
  process.stdout.write("ALLOW\n");
}

function runSelfTest() {
  const cases = [
    [{ answers: [{ optionIds: ["once"] }] }, "allow"],
    [{ answers: [{ optionIds: ["always"] }] }, "always"],
    [{ answers: [{ optionIds: ["reject"] }] }, "reject"],
    [{ answers: [{ optionIds: [], customText: "yes" }] }, "allow"],
    [{ answers: [{ optionIds: [], customText: "YES!" }] }, "allow"],
    [{ answers: [{ optionIds: [], customText: "允许" }] }, "allow"],
    [{ answers: [{ optionIds: [], customText: "同意" }] }, "allow"],
    [{ answers: [{ optionIds: [], customText: "always" }] }, "always"],
    [{ answers: [{ optionIds: [], customText: "no" }] }, "reject"],
    [{ answers: [{ optionIds: [], customText: "随便写点" }] }, "reject"],
    [{ answers: [{ optionIds: [], customText: "好，没问题测试过Enter了。" }] }, "allow"],
    [{ answers: [{ optionIds: [], customText: "好的但是先别推" }] }, "reject"],
    [{ answers: [{ optionIds: [], customText: "好不好再说" }] }, "reject"],
    [{ answers: [{ optionIds: [], customText: "我试试" }] }, "reject"],
    [{ answers: [{ optionIds: [], customText: "" }] }, "reject"],
  ];
  let ok = true;
  for (const [claim, expected] of cases) {
    const got = decideFromClaim(claim);
    if (got !== expected) {
      process.stderr.write(`self-test fail: ${JSON.stringify(claim.answers[0])} => ${got} (want ${expected})\n`);
      ok = false;
    }
  }
  const allow = permissionRequestOutput("allow", "x").hookSpecificOutput;
  const deny = permissionRequestOutput("deny", "x").hookSpecificOutput;
  if (allow.hookEventName !== "PermissionRequest" || allow.decision.behavior !== "allow" || deny.decision.behavior !== "deny") {
    process.stderr.write("self-test fail: PermissionRequest 回传格式不对\n");
    ok = false;
  }
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
  const small = { tool_name: "Bash", tool_input: { command: "npm test" }, permission_suggestions: suggestions };
  const big = { tool_name: "Bash", tool_input: { command: "git push origin main" }, permission_suggestions: suggestions };
  if (permissionPrompt(false).options.some((option) => option.id === "always") || canRememberInClaude(big) || !canRememberInClaude(small)) {
    process.stderr.write("self-test fail: 大事不该给「以后都允许」、小事该给\n");
    ok = false;
  }
  if (permissionRequestOutput("allow", "x", suggestions).hookSpecificOutput.decision.updatedPermissions !== suggestions) {
    process.stderr.write("self-test fail: 以后都允许没带上 CC 的建议规则\n");
    ok = false;
  }
  if (permissionKey({ session_id: "s", tool_name: "Bash", tool_input: { a: 1, b: 2 } }) !== permissionKey({ session_id: "s", tool_name: "Bash", tool_input: { b: 2, a: 1 } })) {
    process.stderr.write("self-test fail: 同一请求算出的号不一样\n");
    ok = false;
  }
  if (!shouldGateThroughPet("PermissionRequest", small, "claude-code") || shouldGateThroughPet("PermissionRequest", { tool_name: "AskUserQuestion" }, "claude-code")
    || shouldGateThroughPet("Notification", { message: "Claude needs your permission" }, "claude-code")) {
    process.stderr.write("self-test fail: 该弹的没弹 / 不该弹的弹了\n");
    ok = false;
  }
  const tmpTranscript = join(process.env.TEMP || hubDataDir(), `pet-self-test-${process.pid}.jsonl`);
  try {
    mkdirSync(join(process.env.TEMP || hubDataDir()), { recursive: true });
    writeFileSync(tmpTranscript, '{"type":"assistant"}\n', "utf8");
    const initSize = transcriptSize(tmpTranscript);
    if (answeredInTranscript(tmpTranscript, initSize) || !isPidAlive(process.pid) || isPidAlive(99999999)) {
      process.stderr.write("self-test fail: 初始状态误判\n");
      ok = false;
    }
    writeFileSync(tmpTranscript, '{"type":"assistant"}\n{"type":"user","message":{"role":"user","content":[{"type":"tool_result","is_error":true,"content":"The user doesn\'t want to proceed"}]}}\n', "utf8");
    if (!answeredInTranscript(tmpTranscript, initSize)) {
      process.stderr.write("self-test fail: 终端先答后 transcript 新增 user 行没认出来\n");
      ok = false;
    }
  } finally {
    try { unlinkSync(tmpTranscript); } catch { /* ignore */ }
  }
  if (ok) process.stdout.write("SELF-TEST OK\n");
  return ok;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRequest(method, params) {
  const discovery = JSON.parse(readFileSync(discoveryPath(), "utf8"));
  if (discovery.app !== APP_ID || discovery.version !== PROTOCOL_VERSION || !discovery.endpoint || !discovery.token) {
    throw new Error("invalid discovery");
  }
  const id = randomUUID();
  const request = { id, version: PROTOCOL_VERSION, token: discovery.token, method, params };
  return new Promise((resolve, reject) => {
    const socket = createConnection(discovery.endpoint);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1_200);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("timeout", () => fail(new Error("timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) return fail(new Error("response too large"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response.id !== id || response.app !== APP_ID || !response.ok) return fail(new Error("bad response"));
        settled = true;
        socket.end();
        resolve(response.result);
      } catch (error) { fail(error); }
    });
  });
}

async function publishOnce(event) {
  const discovery = JSON.parse(readFileSync(discoveryPath(), "utf8"));
  if (discovery.app !== APP_ID || discovery.version !== PROTOCOL_VERSION || !discovery.endpoint || !discovery.token) {
    throw new Error("invalid discovery");
  }
  const id = randomUUID();
  const request = { id, version: PROTOCOL_VERSION, token: discovery.token, method: "event.publish", params: event };
  await new Promise((resolve, reject) => {
    const socket = createConnection(discovery.endpoint);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(650);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("timeout", () => fail(new Error("timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) return fail(new Error("response too large"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response.id !== id || response.app !== APP_ID || !response.ok) return fail(new Error("bad response"));
        settled = true;
        socket.end();
        resolve(response.result);
      } catch (error) { fail(error); }
    });
  });
}

async function publish(event) {
  // 原来是 10 秒。桌宠没开时这 10 秒会实打实地卡住 CC 的每一次提问、工具调用和回答。
  // 桌宠开着但一时忙不过来，1 秒也够补上了。
  const deadline = Date.now() + 1_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await publishOnce(event);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error("publish failed");
}
