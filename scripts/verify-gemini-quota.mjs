// 隔离编译+公共Playwright驱动；不清日常dist、不接日常数据、不动主鼠标。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");
const root = resolve("."), run = mkdtempSync(join(root, ".runtime", "bm-gemini-")), build = join(run, "build"), home = join(run, "home");
mkdirSync(home, { recursive: true });
const env = { ...process.env, AGENT_PET_HUB_HOME: home, AGENT_PET_SKIP_INTEGRATION_INSTALL: "1" };
function command(args) {
  const p = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (p.status !== 0) { process.stdout.write(p.stdout || ""); process.stderr.write(p.stderr || ""); throw new Error("Validation command failed"); }
  return p.stdout;
}
command(["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", build]);
function copyAssets(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith("_")) continue;
    const src = join(from, entry.name), dst = join(to, entry.name);
    if (entry.isDirectory()) copyAssets(src, dst);
    else if (!entry.name.endsWith(".ts")) cpSync(src, dst);
  }
}
copyAssets(join(root, "src"), build); cpSync(join(root, "assets"), join(build, "assets"), { recursive: true });
cpSync(join(root, "skills（看板内置模型用·整理捆的规矩）"), join(build, "skills（看板内置模型用·整理捆的规矩）"), { recursive: true });
cpSync(join(root, "vivo配套（拖图补丁·插件·一键装）"), join(run, "vivo配套（拖图补丁·插件·一键装）"), { recursive: true });
cpSync(join(root, "integrations"), join(build, "integrations"), { recursive: true });
const tests = readdirSync(join(build, "testkit", "tests")).filter(n => n.endsWith(".test.js")).map(n => join(build, "testkit", "tests", n));
const unit = command(["--test", "--test-reporter=tap", ...tests]);
writeFileSync(join(run, "unit.log"), unit);
console.log(unit.split("\n").filter(l => /^# (tests|pass|fail|duration_ms)|^not ok/.test(l)).join("\n"));
console.log(command(["--test", "--test-reporter=tap", "integrations/opencode/completion-gate.test.mjs"]).split("\n").filter(l => /^# (tests|pass|fail)/.test(l)).join("\n"));
const electron = await _electron.launch({ executablePath: join(root, "node_modules", "electron", "dist", "electron.exe"), args: [join(build, "testkit", "gemini-quota-host.js")], env, timeout: 30000 });
const msg = (accountId = "aaaaaaaa", sourceId = "ui-source-1", used = 12, observedAt = Date.now()) => ({ kind: "reading", accountId, sourceId, observedAt,
  current: { used, reset: { raw: "8:19", epoch: null } }, weekly: { used: 40, reset: { raw: "10月22日4:19", epoch: null } } });
try {
  const deadline = Date.now() + 15000;
  const configFile = join(home, "gemini", "receiver.json");
  while (!existsSync(configFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert(existsSync(configFile));
  const config = JSON.parse(readFileSync(configFile, "utf8")), base = "http://127.0.0.1:" + config.port;
  const headers = { Authorization: "Bearer " + config.token, "Content-Type": "application/json" };
  const send = async m => { const r = await fetch(base + "/ingest", { method: "POST", headers, body: JSON.stringify(m) }); assert.equal(r.status, 200); };
  await send(msg());
  const page = await electron.firstWindow();
  await page.waitForSelector(".quota-bubble");
  assert.equal(await page.locator(".quota-bubble").count(), 1);
  assert((await page.textContent("body")).includes("5h 已用 12%"));
  assert((await page.textContent("body")).includes("重置 8:19"));
  assert(!(await page.textContent("body")).includes("40%")); // 周额度不常显。
  await send(msg("aaaaaaaa", "ui-source-2")); await page.waitForTimeout(2200);
  assert.equal(await page.locator(".quota-bubble").count(), 1);
  await send(msg("bbbbbbbb", "ui-source-3", 60));
  await page.waitForFunction(() => document.querySelectorAll(".quota-bubble").length === 2);
  await send(msg("cccccccc", "ui-source-4", 90));
  await page.waitForFunction(() => document.querySelectorAll(".quota-bubble").length === 3);
  const geometry = await page.locator(".quota-bubble").evaluateAll(els => els.map(e => { const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width,height:r.height}; }));
  assert(geometry.every((r, i) => r.width <= 116 && Math.abs(r.height - 44) < 0.5 && (!i || r.top >= geometry[i-1].bottom)), JSON.stringify(geometry));
  const windowState = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({title:w.getTitle(),focusable:w.isFocusable(),focused:w.isFocused(),bounds:w.getBounds()})));
  assert(windowState.every(w => w.focusable === false && w.focused === false));
  await page.screenshot({ path: join(run, "v1_三账号隔离测试.png") });
  await send({ kind: "bye", accountId: "bbbbbbbb", sourceId: "ui-source-3" });
  await send({ kind: "bye", accountId: "cccccccc", sourceId: "ui-source-4" });
  await page.waitForFunction(() => document.querySelectorAll(".quota-bubble").length === 1);
  await send(msg("aaaaaaaa", "ui-source-1", 12, Date.now() - 15 * 60000)); // 不倒灌覆盖新数。
  assert.equal((await (await fetch(base + "/snapshot", {headers})).json()).accounts[0].stale, false);
  await page.screenshot({ path: join(run, "v1_单账号隔离测试.png") });
  const result = { unit: "passed", ui: "passed", isolatedData: true, userDistUntouched: true, realGoogleAccount: false, accounts: [1,2,3], noFocus: true, screenshotDirectory: run };
  writeFileSync(join(run, "gemini-quota-ok.json"), JSON.stringify(result, null, 2));
  console.log("GEMINI_UI_OK single/multiple/dedupe/reset/weekly-hidden/close/no-focus");
  console.log("REPORT " + run);
} finally { await electron.close(); }

for (const mode of ["controls", "lifecycle", "smoke"]) {
  const modeHome = join(run, mode); mkdirSync(modeHome, { recursive: true });
  const result = spawnSync(join(root, "node_modules", "electron", "dist", "electron.exe"), [join(build, "app.js"), "--" + mode + "-test", "--skip-integration-install"],
    { cwd: root, env: { ...env, AGENT_PET_HUB_HOME: modeHome }, encoding: "utf8", windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(join(run, mode + ".log"), (result.stdout || "") + (result.stderr || ""));
  if (result.status !== 0 || !existsSync(join(modeHome, mode + "-ok.json"))) {
    console.log((result.stdout || "") + (result.stderr || "")); throw new Error(mode + " isolated regression failed");
  }
  console.log(mode.toUpperCase() + "_ISOLATED_OK");
}
