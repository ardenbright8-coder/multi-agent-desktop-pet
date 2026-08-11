import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const marker = "multi-agent-desktop-pet managed Hermes plugin v1";
const source = resolve("integrations", "hermes");
const target = "D:\\hermes\\plugins\\multi-agent-desktop-pet";
const bridgeSource = resolve("integrations", "hooks", "agent-pet-hook.mjs");
const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const bridgeTarget = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");

installBridge();
if (existsSync(join(target, "__init__.py"))) {
  const current = readFileSync(join(target, "__init__.py"), "utf8");
  if (!current.includes(marker)) throw new Error(`Refusing to overwrite an unmanaged Hermes plugin: ${target}`);
  const next = readFileSync(join(source, "__init__.py"), "utf8");
  if (current !== next) backupCurrent();
}
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
const verified = readFileSync(join(target, "__init__.py"), "utf8");
if (!Buffer.byteLength(verified, "utf8") || !verified.includes(marker)) throw new Error("Hermes plugin verification failed");
process.stdout.write(`HERMES_PLUGIN_INSTALLED ${target}\n`);

function installBridge() {
  const content = readFileSync(bridgeSource, "utf8");
  if (!content.includes("multi-agent-desktop-pet managed generic hook bridge v1")) throw new Error("Bridge marker is missing");
  mkdirSync(dirname(bridgeTarget), { recursive: true });
  copyFileSync(bridgeSource, bridgeTarget);
}

function backupCurrent() {
  const backupDir = "D:\\hermes\\plugins\\_old";
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  cpSync(target, join(backupDir, `multi-agent-desktop-pet-backup-before-update-${stamp}`), { recursive: true });
}
