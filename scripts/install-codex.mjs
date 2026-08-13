import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const marker = "multi-agent-desktop-pet managed generic hook bridge v1";
const source = resolve("integrations", "hooks", "agent-pet-hook.mjs");
const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
const bridge = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");
const hooksPath = join(homedir(), ".codex", "hooks.json");
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

installBridge();
const installed = mergeCodexHooks();
process.stdout.write(`CODEX_HOOKS_INSTALLED events=${installed} file=${hooksPath} bridge=${bridge}\n`);

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

function mergeCodexHooks() {
  const existing = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : {};
  existing.hooks ||= {};
  const quoted = `"${bridge.replaceAll("\\", "/")}"`;
  let changed = false;
  for (const event of events) {
    existing.hooks[event] = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
    const command = `node ${quoted} codex ${event}`;
    let found = false;
    for (const group of existing.hooks[event]) {
      group.hooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (const hook of group.hooks) {
        if (typeof hook?.command === "string" && hook.command.includes("agent-pet-hook.mjs") && hook.command.includes(` codex ${event}`)) {
          found = true;
          if (hook.command !== command) {
            hook.command = command;
            hook.commandWindows = command;
            hook.timeout = event === "PermissionRequest" ? 8 : 8;
            changed = true;
          }
        }
      }
    }
    if (found) continue;
    existing.hooks[event].push({
      hooks: [{ type: "command", command, commandWindows: command, timeout: 8 }],
    });
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    if (existsSync(hooksPath)) {
      const backupDir = join(dirname(hooksPath), "_old");
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(hooksPath, join(backupDir, `hooks.json.backup-before-agent-pet-${stamp}`));
    }
    const temp = `${hooksPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    renameSync(temp, hooksPath);
  }
  const verified = JSON.parse(readFileSync(hooksPath, "utf8"));
  const count = events.filter((event) =>
    Array.isArray(verified.hooks?.[event]) && verified.hooks[event].some((group) =>
      Array.isArray(group?.hooks) && group.hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes("agent-pet-hook.mjs") && hook.command.includes(` codex ${event}`)),
    ),
  ).length;
  if (count !== events.length) throw new Error(`Codex hook verification failed: ${count}/${events.length}`);
  return count;
}
