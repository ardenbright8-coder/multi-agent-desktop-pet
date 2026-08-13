import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const marker = "multi-agent-desktop-pet managed opencode plugin v1";
const source = resolve("integrations", "opencode", "multi-agent-desktop-pet.mjs");
const target = resolve(homedir(), ".config", "opencode", "plugins", "multi-agent-desktop-pet.js");
const content = readFileSync(source, "utf8");
if (!content.includes(marker)) throw new Error("Source plugin marker is missing");
if (existsSync(target)) {
  const current = readFileSync(target, "utf8");
  if (!current.includes(marker)) throw new Error(`Refusing to overwrite an unmanaged plugin: ${target}`);
  if (current !== content) {
    const backupDir = join(dirname(target), "_old");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(target, join(backupDir, `multi-agent-desktop-pet.js.backup-before-update-${stamp}`));
  }
}
mkdirSync(dirname(target), { recursive: true });
const temp = `${target}.${process.pid}.tmp`;
writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
renameSync(temp, target);
registerPluginInConfig(target);
process.stdout.write(`OPENCODE_PLUGIN_INSTALLED ${target}\n`);

function registerPluginInConfig(pluginPath) {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(configPath)) return;
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const wanted = pluginPath.replaceAll("\\", "/");
  const current = Array.isArray(config.plugin) ? config.plugin.map(String) : [];
  if (current.some((item) => item.replaceAll("\\", "/") === wanted || item.includes("multi-agent-desktop-pet"))) return;
  const next = [...current, wanted];
  const backupDir = join(dirname(configPath), "_old");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(configPath, join(backupDir, `opencode.json.backup-before-agent-pet-plugin-${stamp}`));
  config.plugin = next;
  const tempConfig = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tempConfig, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tempConfig, configPath);
}
