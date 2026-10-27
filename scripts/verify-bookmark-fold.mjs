// 「更多 Agent」折叠区回归验证（Playwright·零抢鼠标）（2026-10-27 看板 01）：
//   ① 第一次：Claude 在上面，别的组都收在「更多 Agent」横条下面、先展开着
//   ② 点横条收起：收进去的组不见了，横条上写着收了哪几组；重开看板还是收着（记在 agents-fold.json）
//   ③ 新加的 Agent 自动收进来
//   ④ 右键横条拿出一组：它回到上面；号码跟板上显示的顺序一样（show 第 01 条就是板上第一条）
// 用法：npm run build 之后 node scripts/verify-bookmark-fold.mjs
// 注意：独立 AGENT_PET_HUB_HOME 起实例，不碰真看板。

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const cliScript = join(root, "scripts", "bookmark-cli.mjs");
const home = mkdtempSync(join(tmpdir(), "bm-fold-"));
const env = { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home };
const foldFile = join(home, "bookmark", "agents-fold.json");
const foldNow = () => (existsSync(foldFile) ? JSON.parse(readFileSync(foldFile, "utf8")) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failed += 1;
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}
function runCli(args) {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
async function openBoard() {
  const app = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(root, "dist/app.js")], env });
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().includes("bookmark/renderer"));
    if (!page) await sleep(100);
  }
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  await page.setViewportSize({ width: 560, height: 900 });
  await page.locator("#tab-groups").click();
  await waitFor(async () => (await page.locator("#board .fold-bar").count()) === 1);
  return { app, page };
}
const shownGroups = (page) => page.evaluate(() => [...document.querySelectorAll("#board .group:not(.handoff-zone)")].map((g) => g.dataset.group));
const barText = (page) => page.locator("#board .fold-bar").innerText();

let app;
let page;
try {
  ({ app, page } = await openBoard());
  // ① 第一次
  const first = await shownGroups(page);
  check("① Claude 在最上面，别的组收在「更多 Agent」下面、先展开着",
    first[0] === "Claude" && first.length === 5 && /▾ 更多 Agent/.test(await barText(page)) && foldNow()?.展开 === true && !foldNow().收起的组.includes("Claude"), `${first.join(",")} | ${await barText(page)}`);
  await page.evaluate(() => window.bookmark.add({ text: "Claude 的活", assignee: "Claude" }));
  await page.evaluate(() => window.bookmark.add({ text: "Hermes 的活", assignee: "Hermes" }));
  await page.evaluate(() => bmRefresh());

  // ② 收起，重开还是收着
  await page.locator("#board .fold-bar").click();
  await waitFor(async () => (await shownGroups(page)).length === 1);
  const bar = await barText(page);
  check("② 点横条收起：只剩 Claude，横条写着收了哪几组、几条", (await shownGroups(page)).join() === "Claude" && /▸ 更多 Agent/.test(bar) && /Hermes/.test(bar) && /1 条/.test(bar), bar);
  await app.close();
  ({ app, page } = await openBoard());
  check("② 重开看板：还是收着", (await shownGroups(page)).join() === "Claude" && foldNow()?.展开 === false, (await shownGroups(page)).join());

  // ③ 新加的 Agent 自动收进来
  await page.evaluate(() => window.bookmark.addAgent("Gemini"));
  await page.evaluate(() => bmRefresh());
  await waitFor(async () => /Gemini/.test(await barText(page)));
  check("③ 新加的 Agent 自动收进「更多 Agent」", foldNow()?.收起的组.includes("Gemini") && (await shownGroups(page)).join() === "Claude", await barText(page));

  // ④ 右键拿出 Hermes：回到上面；号码跟板上顺序一样
  await page.locator("#board .fold-bar").click({ button: "right" });
  await page.locator("#ctx-menu .ctx-item", { hasText: "Hermes" }).click();
  await waitFor(async () => (await shownGroups(page)).join() === "Claude,Hermes");
  check("④ 右键横条拿出 Hermes：它回到上面", (await shownGroups(page)).join() === "Claude,Hermes" && !foldNow().收起的组.includes("Hermes"), (await shownGroups(page)).join());
  const nums = await page.evaluate(() => [...document.querySelectorAll("#board .group:not(.handoff-zone) .task .num")].map((n) => n.textContent));
  const second = runCli(["show", "2"]);
  check("④ 号码跟板上顺序一样：板上 01、02，show 2 是 Hermes 那条", nums.join() === "01,02" && /第 02 条 · Hermes 组/.test(second.out), `${nums.join()} | ${second.out.split("\n")[2] ?? ""}`);
  console.log(failed ? `结果：${failed} 项没过` : "结果：全部验证点通过");
} finally {
  if (app) await app.close();
}
process.exit(failed ? 1 : 0);
