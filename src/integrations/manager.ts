import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appDataRoot } from "../shared/paths";

const OPENCODE_MARKER = "multi-agent-desktop-pet managed opencode plugin v1";
const HOOK_BRIDGE_MARKER = "multi-agent-desktop-pet managed generic hook bridge v1";
const HOOK_FILE = "agent-pet-hook.mjs";

/**
 * 各家 Agent 调的那份钩子桥，固定住在桌宠数据夹里（跟 Pi 插件认的同一处）。
 * 数据夹跟着 AGENT_PET_HUB_HOME 走，没设才落回 %APPDATA%\AgentPetHub。
 * 2026-10-31 之前这里写死 %APPDATA%，数据搬到 F 盘后 Claude/Grok/Hermes 还跑 C 盘那份旧的。
 */
export function hookBridgePath(): string {
  return join(appDataRoot(), "integrations", HOOK_FILE);
}

export function ensureOpenCodeIntegration(): { installed: boolean; changed: boolean; target: string; reason?: string } {
  const source = join(__dirname, "..", "integrations", "opencode", "multi-agent-desktop-pet.mjs");
  const target = join(homedir(), ".config", "opencode", "plugins", "multi-agent-desktop-pet.js");
  const content = readFileSync(source, "utf8");
  if (!content.includes(OPENCODE_MARKER)) throw new Error("Packaged OpenCode plugin marker is missing");

  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    if (!current.includes(OPENCODE_MARKER)) {
      return { installed: false, changed: false, target, reason: "unmanaged-name-conflict" };
    }
    if (current === content) {
      const listed = listOpenCodePlugin(target);
      return { installed: true, changed: listed, target };
    }
  }

  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  listOpenCodePlugin(target);
  return { installed: true, changed: true, target };
}

function listOpenCodePlugin(pluginPath: string): boolean {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(configPath)) return false;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { plugin?: unknown };
  const wanted = pluginPath.replaceAll("\\", "/");
  const current = Array.isArray(config.plugin) ? config.plugin.map(String) : [];
  if (current.some((item) => item.replaceAll("\\", "/") === wanted || item.includes("multi-agent-desktop-pet"))) return false;
  config.plugin = [...current, wanted];
  const temp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, configPath);
  return true;
}

export function ensureGrokHooks(): { installed: boolean; changed: boolean; target: string; reason?: string } {
  const source = join(__dirname, "..", "integrations", "hooks", HOOK_FILE);
  const bridge = hookBridgePath();
  const target = join(homedir(), ".grok", "hooks", "multi-agent-desktop-pet.json");
  const events = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "Notification", "Stop", "StopFailure", "SessionEnd",
  ];
  const quoted = `"${bridge.replaceAll("\\", "/")}"`;
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: `node ${quoted} grok ${event}`, timeout: event === "PreToolUse" ? 180 : 8 }] }];
  }
  const body = `${JSON.stringify({ hooks }, null, 2)}\n`;
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    if (!current.includes("agent-pet-hook.mjs")) return { installed: false, changed: false, target, reason: "unmanaged-name-conflict" };
    if (current === body) return { installed: true, changed: false, target };
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, target);
  if (!existsSync(source)) return { installed: true, changed: true, target, reason: "bridge-source-missing" };
  return { installed: true, changed: true, target };
}

export function ensureGenericHookBridge(): { installed: boolean; changed: boolean; target: string; reason?: string } {
  const source = join(__dirname, "..", "integrations", "hooks", HOOK_FILE);
  const target = hookBridgePath();
  const content = readFileSync(source, "utf8");
  if (!content.includes(HOOK_BRIDGE_MARKER)) throw new Error("Packaged generic hook bridge marker is missing");
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    if (!current.includes(HOOK_BRIDGE_MARKER)) return { installed: false, changed: false, target, reason: "unmanaged-name-conflict" };
    if (current === content) return { installed: true, changed: false, target };
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  return { installed: true, changed: true, target };
}

const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Elicitation",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "Notification",
] as const;

/**
 * 核对并补齐 Claude Code 的 11 个桌宠钩子（只改/补带 agent-pet-hook.mjs 的条目，用户自己的其它设置和钩子一个字不碰）。
 * 2026-11-01：之前只替换已有条目的路径，导致在「根」新加的钩子切到「燊一修」后缺了 8 个事件（终端答完桌宠窗不收）。
 */
export function ensureClaudeHooks(settingsFile = join(homedir(), ".claude", "settings.json")): boolean {
  if (!existsSync(settingsFile)) return false;
  const bridge = hookBridgePath();
  if (!existsSync(bridge)) return false;
  const raw = readFileSync(settingsFile, "utf8");
  let settings: { hooks?: Record<string, unknown> } & Record<string, unknown>;
  try {
    settings = JSON.parse(raw.replace(/^\uFEFF/, "")) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
  } catch {
    return false;
  }
  if (!settings || typeof settings !== "object") return false;
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const quoted = `"${bridge.replaceAll("\\", "/")}"`;
  let changed = false;

  for (const event of CLAUDE_EVENTS) {
    const command = `node ${quoted} claude-code ${event}`;
    const minTimeout = event === "PreToolUse" || event === "PermissionRequest" || event === "Notification" ? 130 : 8;
    const defaultTimeout = event === "PreToolUse" || event === "PermissionRequest" || event === "Notification" ? 180 : 8;
    const groups = Array.isArray(settings.hooks[event])
      ? (settings.hooks[event] as { matcher?: unknown; hooks?: { type?: unknown; command?: unknown; timeout?: unknown }[] }[])
      : [];
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = groups;
      changed = true;
    }
    let found = false;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook?.command !== "string" || !hook.command.includes(HOOK_FILE)) continue;
        if (!hook.command.includes(`claude-code ${event}`) && hook.command.includes("claude-code ")) continue;
        found = true;
        if (hook.command !== command) {
          hook.command = command;
          changed = true;
        }
        if (typeof hook.timeout !== "number" || hook.timeout < minTimeout) {
          hook.timeout = defaultTimeout;
          changed = true;
        }
      }
    }
    if (!found) {
      groups.push({ matcher: "", hooks: [{ type: "command", command, timeout: defaultTimeout }] });
      changed = true;
    }
  }

  if (!changed) return false;
  const backupDir = join(process.env.LOCALAPPDATA || tmpdir(), "AgentPetHub", "改钩子路径前的原件");
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(settingsFile, join(backupDir, "claude-settings.json"));
  const temp = `${settingsFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, settingsFile);
  return true;
}

/**
 * 核对并补齐 Antigravity（~/.gemini/config/hooks.json）的桌宠钩子。
 * 只管顶层 "multi-agent-desktop-pet" 那一块，其它命名钩子不动。
 */
const ANTIGRAVITY_KEY = "multi-agent-desktop-pet";
const ANTIGRAVITY_STUB = "agent-pet-hook-stub.mjs";

/** 门卫脚本：住在 Antigravity 自己的配置夹，桌宠钩子找不到或加载出错就放行，免得数据夹挪走、桌宠删掉后 Antigravity 被拦死。 */
export function antigravityStubSource(bridge: string): string {
  return [
    "// multi-agent-desktop-pet antigravity stub v1：桌宠每次启动自动重写，别手改",
    'import { existsSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    `const REAL = ${JSON.stringify(bridge.replaceAll("\\", "/"))};`,
    "function allow() {",
    '  const hook = String(process.argv[3] || "").toLowerCase();',
    '  process.stdout.write(hook.includes("pretooluse") ? \'{"decision":"allow"}\\n\' : "{}\\n");',
    "  process.exit(0);",
    "}",
    "if (!existsSync(REAL)) allow();",
    "try { await import(pathToFileURL(REAL).href); } catch { allow(); }",
    "",
  ].join("\n");
}

function nodeOnPath(): boolean {
  const dirs = (process.env.PATH || process.env.Path || "").split(";").filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, "node.exe")) || existsSync(join(dir, "node")));
}

function writeAtomic(file: string, body: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, file);
}

export function ensureAntigravityHooks(
  hooksFile = join(homedir(), ".gemini", "config", "hooks.json"),
  hasNode: () => boolean = nodeOnPath,
): boolean {
  if (!existsSync(dirname(hooksFile))) return false;
  const bridge = hookBridgePath();
  if (!existsSync(bridge)) return false;
  let config: Record<string, unknown> = {};
  if (existsSync(hooksFile)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksFile, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      else return false;
    } catch {
      return false;
    }
  }
  // 没装 Node.js：命令一跑就失败，PreToolUse 会把 Antigravity 全挡住，所以摘掉自己那块
  if (!hasNode()) {
    if (!(ANTIGRAVITY_KEY in config)) return false;
    delete config[ANTIGRAVITY_KEY];
    writeAtomic(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  }
  // Antigravity 在 Windows 上按空格切命令、不去引号：路径带引号会被当成文件名的一部分，
  // PreToolUse（matcher "*"）一失败就把它所有工具调用全挡住。所以这里不加引号；门卫路径带空格就不挂，宁可不接也不能锁死。
  const stubFile = join(dirname(hooksFile), ANTIGRAVITY_STUB);
  const quoted = stubFile.replaceAll("\\", "/");
  if (/\s|"/.test(quoted)) return false;
  const stubBody = antigravityStubSource(bridge);
  let stubChanged = false;
  if (!existsSync(stubFile) || readFileSync(stubFile, "utf8") !== stubBody) {
    writeAtomic(stubFile, stubBody);
    stubChanged = true;
  }
  const wanted = {
    SessionStart: [{ type: "command", command: `node ${quoted} antigravity SessionStart`, timeout: 8 }],
    PreInvocation: [{ type: "command", command: `node ${quoted} antigravity PreInvocation`, timeout: 8 }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${quoted} antigravity PreToolUse`, timeout: 180 }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${quoted} antigravity PostToolUse`, timeout: 8 }] }],
    Stop: [{ type: "command", command: `node ${quoted} antigravity Stop`, timeout: 8 }],
  };
  if (JSON.stringify(config[ANTIGRAVITY_KEY]) === JSON.stringify(wanted)) return stubChanged;
  if (existsSync(hooksFile)) {
    const backupDir = join(process.env.LOCALAPPDATA || tmpdir(), "AgentPetHub", "改钩子路径前的原件");
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(hooksFile, join(backupDir, "antigravity-hooks.json"));
  }
  config[ANTIGRAVITY_KEY] = wanted;
  writeAtomic(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/**
 * 各家配置里挂着的桌宠钩子，路径和条目跟着 hookBridgePath() 走（照 Clawd on Desk 启动自检那套）。
 * 只改/补命令里带 agent-pet-hook.mjs 的那几条，别人的钩子、其余设置一个字不碰；
 * 改之前把原件拷一份到本机 LOCALAPPDATA（不放共用盘，Claude 配置两套各管各）。
 */
export function ensureAgentHookPaths(): { changed: string[]; skipped?: string } {
  const bridge = hookBridgePath();
  if (!existsSync(bridge)) return { changed: [], skipped: "bridge-missing" };
  const changed: string[] = [];
  const claudeSettings = join(homedir(), ".claude", "settings.json");
  if (ensureClaudeHooks(claudeSettings)) changed.push(claudeSettings);
  const antigravityHooks = join(homedir(), ".gemini", "config", "hooks.json");
  if (ensureAntigravityHooks(antigravityHooks)) changed.push(antigravityHooks);
  const grokSettings = join(homedir(), ".grok", "hooks", "multi-agent-desktop-pet.json");
  if (repointHookCommands(grokSettings, bridge)) changed.push(grokSettings);
  return { changed };
}

function repointHookCommands(file: string, bridge: string): boolean {
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, "utf8");
  const config = JSON.parse(raw.replace(/^﻿/, "")) as { hooks?: Record<string, unknown> };
  const quoted = `"${bridge.replaceAll("\\", "/")}"`;
  const pairs: [string, string][] = [];
  for (const groups of Object.values(config.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as { hooks?: { command?: unknown }[] }[]) {
      for (const hook of group.hooks || []) {
        if (typeof hook.command !== "string" || !hook.command.includes(HOOK_FILE)) continue;
        const next = hook.command.replace(/"[^"]*agent-pet-hook\.mjs"|[^\s"]*agent-pet-hook\.mjs/, quoted);
        if (next === hook.command) continue;
        pairs.push([JSON.stringify(hook.command), JSON.stringify(next)]);
        hook.command = next;
      }
    }
  }
  if (!pairs.length) return false;
  let text = raw;
  for (const [from, to] of pairs) text = text.split(from).join(to);
  // 原文转义写法跟 JSON.stringify 对不上时，退回整份重写
  try {
    JSON.parse(text.replace(/^﻿/, ""));
    if (pairs.some(([from]) => text.includes(from))) throw new Error("leftover");
  } catch {
    text = `${JSON.stringify(config, null, 2)}\n`;
  }
  const backupDir = join(process.env.LOCALAPPDATA || tmpdir(), "AgentPetHub", "改钩子路径前的原件");
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(file, join(backupDir, file.includes(".grok") ? "grok-hooks.json" : "claude-settings.json"));
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
  return true;
}
