import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const marker = "multi-agent-desktop-pet managed generic hook bridge v1";
const source = resolve("integrations", "hooks", "agent-pet-hook.mjs");
const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
const target = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
const settingsPath = join(homedir(), ".claude", "settings.json");
const events = [
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
];

installBridge();
installHooks();

function installBridge() {
  const content = readFileSync(source, "utf8");
  if (!content.includes(marker)) throw new Error("Generic hook bridge marker is missing");
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    if (!current.includes(marker)) throw new Error(`Refusing to overwrite an unmanaged bridge: ${target}`);
    if (current === content) return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

function installHooks() {
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ||= {};
  let changed = false;
  for (const event of events) {
    settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const command = `node ${quote(target.replaceAll("\\", "/"))} claude-code ${event}`;
    let alreadyInstalled = false;
    for (const group of settings.hooks[event]) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook?.command !== "string" || !hook.command.includes("agent-pet-hook.mjs") || !hook.command.includes(`claude-code ${event}`)) continue;
        alreadyInstalled = true;
        if (hook.command !== command) {
          hook.command = command;
          changed = true;
        }
      }
    }
    if (alreadyInstalled) continue;
    settings.hooks[event].push({ matcher: "", hooks: [{ type: "command", command }] });
    changed = true;
  }

  if (changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existsSync(settingsPath)) {
      const backupDir = join(dirname(settingsPath), "_old");
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(settingsPath, join(backupDir, `settings.json.backup-before-agent-pet-hooks-${stamp}`));
    }
    const temp = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(temp, settingsPath);
  }

  const verifiedText = readFileSync(settingsPath, "utf8");
  const verified = JSON.parse(verifiedText);
  const installedCount = events.filter((event) =>
    Array.isArray(verified.hooks?.[event]) && verified.hooks[event].some((group) =>
      Array.isArray(group?.hooks) && group.hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes("agent-pet-hook.mjs") && hook.command.includes(`claude-code ${event}`)),
    ),
  ).length;
  if (!Buffer.byteLength(verifiedText, "utf8") || installedCount !== events.length) throw new Error(`Claude Code hook verification failed: ${installedCount}/${events.length}`);
  process.stdout.write(`CLAUDE_HOOKS_INSTALLED events=${installedCount} bridge=${target}\n`);
}

function quote(value) {
  return `"${String(value).replaceAll('"', '`"')}"`;
}
