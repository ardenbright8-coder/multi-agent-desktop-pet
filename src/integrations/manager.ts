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

/**
 * 各家配置里挂着的桌宠钩子，路径跟着 hookBridgePath() 走（照 Clawd on Desk 启动自检那套）。
 * 只改命令里带 agent-pet-hook.mjs 的那几条，别人的钩子、其余设置一个字不碰；
 * 文本原样替换，排版不动。改之前把原件拷一份到本机 LOCALAPPDATA（不放共用盘，Claude 配置两套各管各）。
 */
export function ensureAgentHookPaths(): { changed: string[]; skipped?: string } {
  const bridge = hookBridgePath();
  if (!existsSync(bridge)) return { changed: [], skipped: "bridge-missing" };
  const targets = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".grok", "hooks", "multi-agent-desktop-pet.json"),
  ];
  return { changed: targets.filter((file) => repointHookCommands(file, bridge)) };
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
