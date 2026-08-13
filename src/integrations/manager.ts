import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const OPENCODE_MARKER = "multi-agent-desktop-pet managed opencode plugin v1";
const HOOK_BRIDGE_MARKER = "multi-agent-desktop-pet managed generic hook bridge v1";

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
  const source = join(__dirname, "..", "integrations", "hooks", "agent-pet-hook.mjs");
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const bridge = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
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
  const source = join(__dirname, "..", "integrations", "hooks", "agent-pet-hook.mjs");
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const target = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
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
