import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(".runtime", "test-runs", `single-instance-${Date.now()}-${process.pid}`);
const temp = join(root, "temp");
mkdirSync(temp, { recursive: true });
const electronCli = resolve("node_modules", "electron", "cli.js");
const packaged = process.argv.includes("--packaged");
const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const command = packaged ? resolve(`release-${version}`, "win-unpacked", "多Agent桌面宠物.exe") : process.execPath;
const args = packaged ? ["--single-instance-host-test"] : [electronCli, ".", "--single-instance-host-test"];
if (!existsSync(command)) throw new Error(`Test executable is missing: ${command}`);
const env = {
  ...process.env,
  AGENT_PET_HUB_HOME: root,
  AGENT_PET_SKIP_INTEGRATION_INSTALL: "1",
  TEMP: temp,
  TMP: temp,
};

const first = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit", windowsHide: false });
await waitFor(() => existsSync(join(root, "runtime", "ipc.json")), 8_000, "First instance did not start its event hub");
const second = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit", windowsHide: false });
const secondCode = await exitCode(second);
if (secondCode !== 0) throw new Error(`Second instance exited with ${secondCode}`);
const firstCode = await exitCode(first);
const report = join(root, "single-instance-ok.json");
if (firstCode !== 0 || !existsSync(report)) throw new Error(`Single-instance host failed with ${firstCode}`);
process.stdout.write(`SINGLE_INSTANCE_SMOKE_OK packaged=${packaged} report=${report}\n`);

function exitCode(child) {
  return new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(message);
}
