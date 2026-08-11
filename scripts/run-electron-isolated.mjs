import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const modeArg = process.argv[2] || "--smoke-test";
const mode = modeArg.replace(/^--/, "").replace(/-test$/, "") || "run";
const root = resolve(".runtime", "test-runs", `${mode}-${Date.now()}-${process.pid}`);
mkdirSync(root, { recursive: true });

const electronCli = resolve("node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [electronCli, ".", modeArg], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGENT_PET_HUB_HOME: root,
    AGENT_PET_SKIP_INTEGRATION_INSTALL: "1",
    TEMP: join(root, "temp"),
    TMP: join(root, "temp"),
  },
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) console.error(`Electron exited by signal ${signal}`);
  const reportName = mode === "smoke" ? "smoke-ok.json" : mode === "screenshot" ? "screenshot-ok.json" : mode === "lifecycle" ? "lifecycle-ok.json" : mode === "controls" ? "controls-ok.json" : "";
  const reportExists = reportName ? existsSync(join(root, reportName)) : true;
  if (!reportExists) console.error(`Electron ${mode} test did not write ${reportName}`);
  process.exitCode = code === 0 && reportExists ? 0 : code || 1;
});
