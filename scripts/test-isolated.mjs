import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".runtime", "test-runs", `unit-${Date.now()}-${process.pid}`);
const temp = join(root, "temp");
mkdirSync(temp, { recursive: true });
const env = {
  ...process.env,
  AGENT_PET_HUB_HOME: root,
  AGENT_PET_SKIP_INTEGRATION_INSTALL: "1",
  TEMP: temp,
  TMP: temp,
};

run(process.execPath, ["scripts/clean.mjs"]);
run(process.execPath, [resolve("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);
run(process.execPath, ["scripts/copy-assets.mjs"]);
for (const file of [
  "integrations/opencode/multi-agent-desktop-pet.mjs",
  "integrations/hooks/agent-pet-hook.mjs",
  "src/pet/renderer/shell.js",
  "src/pet/renderer/pet.js",
  "src/pet/renderer/boot.js",
  "src/interaction/renderer/panel.js",
  "src/events/renderer/drawer.js",
  "scripts/install-claude-code.mjs",
  "scripts/install-pi.mjs",
  "scripts/install-hermes.mjs",
  "scripts/run-electron-isolated.mjs",
  "scripts/single-instance-smoke.mjs",
  "scripts/integration-smoke.mjs",
  "scripts/pack-local.mjs",
  "scripts/verify-package.mjs",
]) run(process.execPath, ["--check", file]);

const tests = readdirSync(resolve("dist", "testkit", "tests"))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => join("dist", "testkit", "tests", name));
run(process.execPath, ["--test", ...tests]);
run(process.execPath, ["--test", "integrations/opencode/completion-gate.test.mjs"]);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
