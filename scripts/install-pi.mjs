import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const marker = "multi-agent-desktop-pet managed Pi extension v1";
const bridgeMarker = "multi-agent-desktop-pet managed generic hook bridge v1";
const piRoot = process.env.PI_CODING_AGENT_DIR || "E:\\个人AI资源管理\\20_环境运维配置（管这台机·服务器·软件设置）\\Pi Agent（终端编程智能体·安装与配置）\\02_运行配置（规则·设置·会话）";
const source = resolve("integrations", "pi", "agent-pet.ts");
const target = join(piRoot, "extensions", "agent-pet.ts");
const bridgeSource = resolve("integrations", "hooks", "agent-pet-hook.mjs");
const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const bridgeTarget = join(appData, "AgentPetHub", "integrations", "agent-pet-hook.mjs");

installManagedFile(bridgeSource, bridgeTarget, bridgeMarker);
if (existsSync(target)) {
  const current = readFileSync(target, "utf8");
  if (!current.includes(marker)) throw new Error(`Refusing to overwrite an unmanaged Pi extension: ${target}`);
  if (current !== readFileSync(source, "utf8")) backup(target);
}
installManagedFile(source, target, marker);
const verified = readFileSync(target, "utf8");
if (!Buffer.byteLength(verified, "utf8") || !verified.includes(marker)) throw new Error("Pi extension verification failed");
process.stdout.write(`PI_EXTENSION_INSTALLED ${target}\n`);

function installManagedFile(from, to, expectedMarker) {
  const content = readFileSync(from, "utf8");
  if (!content.includes(expectedMarker)) throw new Error(`Managed file marker is missing: ${from}`);
  if (existsSync(to)) {
    const current = readFileSync(to, "utf8");
    if (!current.includes(expectedMarker)) throw new Error(`Refusing to overwrite an unmanaged file: ${to}`);
    if (current === content) return;
  }
  mkdirSync(dirname(to), { recursive: true });
  const temp = `${to}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, to);
}

function backup(path) {
  const backupDir = join(dirname(path), "_old");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, join(backupDir, `agent-pet.ts.backup-before-update-${stamp}`));
}
