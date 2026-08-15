// multi-agent-desktop-pet managed generic hook bridge v1
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// ═══ 什么算"大权限"，只有命中这张表的才弹桌宠 ═══
// 标准：碰 Windows 系统那一摊、改网络配置、不可逆、或者往外发。
// 改项目文件、跑测试、本地 git commit 这类小事不算，别弹。
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

const [agentArg = "generic", hookArg = "context.updated"] = argv;

// 桌宠没起来就别耗着——照 app 自带原版的做法：连不上，静默走人，零输出。
// 不加这行的话 publish() 会硬撑重试，然后 failOpen 吐一段 CC 不认的 JSON，
// 结果就是启动慢 10 秒 + 每次回答后打印一整张 schema。
if (!existsSync(discoveryPath())) process.exit(0);

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
    if (shouldGateThroughPet(hookArg, input)) {
      writeHookDecision(agent, await gateThroughPet(agent, hookArg, input));
    } else if (String(hookArg || "").toLowerCase().includes("permissionrequest")) {
      // 小事的权限请求：连报都不报。
      // 不加这条的话，它会掉进上报路径 → 桌宠照样弹一个"不支持回传，请回终端"的窗，
      // 等于白弹一次。小事就该在终端里回车过，桌宠一声不吭。
      process.exit(0);
    } else {
      const event = translate(agent, hookArg, input);
      if (event) await publish(event);
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

function discoveryPath() {
  const root = process.env.AGENT_PET_HUB_HOME
    || join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "AgentPetHub");
  return join(root, "runtime", "ipc.json");
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

  const cwd = firstString(input.cwd, input.workspaceRoot, input.working_directory, input.project_dir, process.env.GROK_WORKSPACE_ROOT, process.env.CLAUDE_PROJECT_DIR, process.cwd());
  const sessionId = firstString(input.session_id, input.sessionId, input.conversation_id, input.task_id, process.env.GROK_SESSION_ID, `${normalizedAgent}-default`);
  const tool = firstString(input.tool_name, input.toolName, input.tool, input.name);
  const toolInput = objectValue(input.tool_input, input.toolInput, input.input, input.arguments);
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
  if (hook === "stop" || hook.includes("task.completed") || hook.includes("complete")) {
    const reason = String(input.reason || input.stopReason || "").toLowerCase();
    if (reason && reason !== "end_turn") return "session.ended";
    return "task.completed";
  }
  if (hook.includes("pretool") || hook.includes("posttool") || hook.includes("tool.") || hook.includes("subagent")) return "state.working";
  if (hook.includes("prompt") || hook.includes("thinking")) return "state.thinking";
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
  if (hook.includes("prompt")) return `${label} 正在理解任务`;
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
    for (const key of ["file_path", "filePath", "path", "command", "url", "query", "pattern", "prompt"]) {
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
  return ({ "claude-code": "Claude Code", opencode: "OpenCode", pi: "Pi", hermes: "Hermes", grok: "Grok", codex: "Codex" })[agent] || agent;
}

function hubDataDir() {
  const root = process.env.AGENT_PET_HUB_HOME
    || join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "AgentPetHub");
  return join(root, "data");
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
  if (REJECT_WORDS.has(text) || text) return "reject";
  return "reject";
}

function permissionPrompt() {
  return {
    id: "permission",
    question: "点一个，或自己填。",
    multiple: false,
    allowCustomInput: true,
    options: [
      { id: "once", label: "允许一次", value: "once", description: "只准这一次", recommended: true },
      { id: "always", label: "以后都允许", value: "always", description: "这家 Agent 先记住，先不问了" },
      { id: "reject", label: "拒绝", value: "reject", description: "这次不执行" },
    ],
  };
}

// CC 对不同事件收的字段不一样，写错一个字它就把整张 schema 打屏幕上。
//   PreToolUse       → hookSpecificOutput.permissionDecision（allow/deny/ask）
//   PermissionRequest→ 顶层 permissionDecision（allow/deny/ask）
//   其它事件（含 Notification）→ 一个字都不能输出
// 顶层的 decision 字段只收 approve/block，之前那版写 "allow" 是非法的，就是报错的根。
function writeHookDecision(agent, decision) {
  if (decision === "always") rememberAlways(agent);
  // 桌宠上没人点 → 不表态，交回给 CC 自己问。别替用户做主。
  if (decision === "timeout") return;
  const hook = String(hookArg || "").toLowerCase();
  const permissionDecision = decision === "reject" ? "deny" : "allow";
  const reason = decision === "reject"
    ? "用户在桌宠上拒绝了这次操作"
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
    process.stdout.write(`${JSON.stringify({ permissionDecision, reason })}\n`);
    return;
  }
  // Notification 之类的事件根本不接受决定，回传也没处使，闭嘴。
}

function failOpen(error) {
  try {
    const dir = hubDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hook-error.log"), `${new Date().toISOString()} ${error?.stack || error}\n`, "utf8");
  } catch { /* 记不住也不能挡 */ }
  // 出错时什么都别输出。上报型钩子的任何 stdout 都会被 CC 当决定去校验，一校验就报错。
  // 放行本来就是"不表态"的默认结果，闭嘴走人即可。
  process.exit(0);
}

function shouldGateThroughPet(hook, input) {
  const name = String(hook || "").toLowerCase();
  if (name.includes("notification")) {
    const text = notificationText(input);
    return text.includes("permission") || text.includes("plan") || text.includes("approval") || text.includes("input");
  }
  // PermissionRequest 是 CC 已经决定要问你了，那就一律走桌宠网关（可回传）。
  // 之前这里跟 PreToolUse 共用工具白名单，ExitPlanMode 这类工具名不匹配就掉进上报路径，
  // 上报路径的 responseCapability 写死 false → 桌宠只能显示"不支持回传，请回终端"。
  // 只有动真格的才弹桌宠。小事让 CC 自己按 settings.json 处理，别烦人。
  if (name.includes("permissionrequest")) return isBigDeal(input);
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
  eat(objectValue(input.tool_input, input.toolInput, input.input, input.arguments));
  eat(firstString(input.tool_name, input.toolName, input.tool));
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

async function gateThroughPet(agent, hook, input) {
  const tool = firstString(input.tool_name, input.toolName, input.tool) || "命令";
  if (isAlwaysRemembered(agent)) {
    await announceChoice(agent, "always", { alwaysRemembered: true, tool });
    return "always";
  }
  const target = targetFrom(objectValue(input.tool_input, input.toolInput, input.input), input) || "未提供目标";
  const requestId = firstString(input.request_id, input.requestId, input.tool_use_id, input.toolUseId, randomUUID());
  const sessionId = firstString(input.session_id, input.sessionId, process.env.GROK_SESSION_ID, `${agent}-default`);
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
      prompts: [permissionPrompt()],
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
  // 等多久是个权衡：
  //   等太久 → 桌宠没人管时，CC 在这儿干站着；
  //   等太短 → 钩子先退了，你再点，桌宠那边永远卡在"正在交回…"（app 侧没有超时处理，
  //            它不知道对面已经没人了）。30 秒实测就短了，人还没走到跟前就超时。
  // 2 分钟（用户定的）：宁可多等，也别出现"点了没人接"。
  // ⚠️ 改这个数就得同步改 settings.json 里 PermissionRequest 那条钩子的 timeout，
  //    CC 的钩子超时默认 60 秒，比这个短的话 CC 会先把进程杀了，白设。
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
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
    const decision = decideFromClaim(claim);
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
