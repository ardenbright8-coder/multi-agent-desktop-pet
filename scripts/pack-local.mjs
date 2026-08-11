import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const output = `release-${version}`;
const runtime = resolve(".runtime", "pack", `${version}-${Date.now()}-${process.pid}`);
const temp = join(runtime, "temp");
const cache = join(runtime, "electron-builder-cache");
mkdirSync(temp, { recursive: true });
mkdirSync(cache, { recursive: true });
const builder = resolve("node_modules", "electron-builder", "cli.js");
const result = spawnSync(process.execPath, [builder, "--dir", `--config.directories.output=${output}`], {
  cwd: process.cwd(),
  env: { ...process.env, TEMP: temp, TMP: temp, ELECTRON_BUILDER_CACHE: cache },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`PACK_LOCAL_OK ${resolve(output, "win-unpacked")}\n`);
