import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const marker = "multi-agent-desktop-pet managed generic hook bridge v1";
const source = resolve("integrations", "hooks", "agent-pet-hook.mjs");
const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
const bridge = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
const hooksDir = join(homedir(), ".grok", "hooks");
const hooksPath = join(hooksDir, "multi-agent-desktop-pet.json");
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

installBridge();
const hooksFile = writeHookFile();
process.stdout.write(`GROK_HOOKS_INSTALLED events=${events.length} file=${hooksFile} bridge=${bridge}\n`);

function installBridge() {
  const content = readFileSync(source, "utf8");
  if (!content.includes(marker)) throw new Error("Generic hook bridge marker is missing");
  if (existsSync(bridge)) {
    const current = readFileSync(bridge, "utf8");
    if (!current.includes(marker)) throw new Error(`Refusing to overwrite an unmanaged bridge: ${bridge}`);
    if (current === content) return;
  }
  mkdirSync(dirname(bridge), { recursive: true });
  const temp = `${bridge}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, bridge);
}

function writeHookFile() {
  const quoted = `"${bridge.replaceAll("\\", "/")}"`;
  const hooks = {};
  for (const event of events) {
    hooks[event] = [{
      matcher: "",
      hooks: [{
        type: "command",
        command: `node ${quoted} grok ${event}`,
        timeout: event === "PreToolUse" ? 180 : 8,
      }],
    }];
  }
  const body = `${JSON.stringify({ hooks }, null, 2)}\n`;
  mkdirSync(hooksDir, { recursive: true });
  if (existsSync(hooksPath)) {
    const current = readFileSync(hooksPath, "utf8");
    if (current === body) return hooksPath;
    if (current.includes("agent-pet-hook.mjs")) {
      const backupDir = join(hooksDir, "_old");
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(hooksPath, join(backupDir, `multi-agent-desktop-pet.json.backup-before-update-${stamp}`));
    } else {
      throw new Error(`Refusing to overwrite an unmanaged Grok hook file: ${hooksPath}`);
    }
  }
  const temp = `${hooksPath}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, hooksPath);
  const verified = readFileSync(hooksPath, "utf8");
  if (!verified.includes("agent-pet-hook.mjs") || !verified.includes(" grok ")) {
    throw new Error("Grok hook file verification failed");
  }
  return hooksPath;
}
