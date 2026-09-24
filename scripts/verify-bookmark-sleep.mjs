// 书签看板「两档：日常档 / 睡觉档」界面验证（2026-09-24 设定18）：
//   ① 标题栏有档位钮，默认「☀️ 日常档」
//   ② 点一下切到「🌙 睡觉档」，存进 mode.json，重开还是睡觉档
//   ③ 切到睡觉档马上看一眼：有活没人干的组（Claude）会开窗贴好领活那句——测试实例只报会怎么做、不真开窗
//   ④ 真敲命令：next --to Claude 领到第一条，领活说明是睡觉档那套（report、按组 next、交接单）
//   ⑤ 真敲 report：条目标成「✅ 干完待审」、报告挂在条目下面、不删；「在干」标记没了
//   ⑥ 再 next --to Claude 领到第二条（报告过的不再领）
//   ⑦ 点报告里的「可以，删掉」→ 这条删掉
//   ⑧ 切回日常档，领活说明回到「等用户说可以再 done」
// 用法：npm run build 之后 node scripts/verify-bookmark-sleep.mjs（隐藏窗口，不抢鼠标键盘，不动系统剪贴板）
// 期望答案都在本脚本里独立写，不调被测函数。

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const cliScript = join(root, "scripts", "bookmark-cli.mjs");
mkdirSync(join(root, ".runtime", "sleep-tests"), { recursive: true });
const hubHome = mkdtempSync(join(root, ".runtime", "sleep-tests", "run-"));

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failures.push(name);
}
async function waitFor(fn, timeoutMs = 8000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}
function runCli(args) {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", env: { ...process.env, AGENT_PET_HUB_HOME: hubHome } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
async function launch() {
  const app = await _electron.launch({
    executablePath: join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [join(root, "scripts", "bookmark-image-test-host.cjs")],
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome, AGENT_PET_SKIP_INTEGRATION_INSTALL: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  page.on("pageerror", (e) => failures.push(`页面报错：${e.message}`));
  return { app, page };
}

let app;
try {
  ({ app } = await launch());
  let page = await app.firstWindow();
  const ids = await page.evaluate(async () => {
    const out = {};
    for (const text of ["睡觉档第二条", "睡觉档第一条"]) {
      const r = await window.bookmark.add({ text });
      await window.bookmark.setAssignee(r.id, "Claude");
      out[text] = r.id;
    }
    return out;
  });
  await page.evaluate(() => bmRefresh());
  await page.locator("#tab-groups").click();

  const btn = page.locator("#mode-btn");
  const t0 = (await btn.count()) ? (await btn.textContent())?.trim() : null;
  check("① 标题栏有档位钮，默认日常档", t0 === "☀️ 日常档", `钮上写=${t0}`);

  if (await btn.count()) await btn.click();
  const t1 = await waitFor(async () => ((await btn.textContent())?.trim() === "🌙 睡觉档" ? "🌙 睡觉档" : null), 5000);
  const modeFile = join(hubHome, "bookmark", "mode.json");
  const saved = existsSync(modeFile) ? readFileSync(modeFile, "utf8") : "";
  check("② 点一下切到睡觉档、存进 mode.json", t1 === "🌙 睡觉档" && saved.includes('"sleep"'), `钮=${await btn.textContent().catch(() => "")} 存档=${saved}`);

  const toast = await waitFor(async () => {
    const text = (await page.locator("#bm-toast").textContent().catch(() => "")) ?? "";
    return text.includes("Claude") ? text : null;
  }, 8000);
  check("③ 切到睡觉档马上给有活没人干的 Claude 组开窗贴好（测试实例不真开）", Boolean(toast), `提示=${toast ?? (await page.locator("#bm-toast").textContent().catch(() => ""))}`);

  const n1 = runCli(["next", "--to", "Claude", "--by", "Claude-7"]);
  check("④ next --to Claude 领到第一条，说明是睡觉档那套",
    n1.code === 0 && n1.out.includes("睡觉档") && n1.out.includes("睡觉档第一条") && n1.out.includes(`report ${ids["睡觉档第一条"]} --by Claude-7 --text`)
      && n1.out.includes('next --to "Claude" --by Claude-7') && n1.out.includes("handoff") && !n1.out.includes(" done "),
    n1.out.slice(0, 300));

  const rep = runCli(["report", ids["睡觉档第一条"], "--by", "Claude-7", "--text", "改好了搜索框，重开看板能看见"]);
  const row1 = page.locator(`#board .task[data-id="${ids["睡觉档第一条"]}"]`);
  const shown = await waitFor(async () => {
    const t = (await row1.locator(".task-report").textContent().catch(() => "")) ?? "";
    return t.includes("改好了搜索框") ? t : null;
  }, 5000);
  const claimGone = (await row1.locator(".claim").count().catch(() => 1)) === 0;
  check("⑤ report 后条目标成干完待审、报告挂在下面、不删、在干标记没了",
    rep.code === 0 && Boolean(shown) && shown.includes("✅ 干完待审") && shown.includes("Claude-7") && claimGone,
    `命令=${rep.out.trim()} 报告块=${shown} 在干没了=${claimGone}`);

  const n2 = runCli(["next", "--to", "Claude", "--by", "Claude-7"]);
  check("⑥ 再 next 领到第二条（报告过的不再领）", n2.code === 0 && n2.out.includes("睡觉档第二条"), n2.out.slice(0, 160));

  const okBtn = row1.locator(".task-report .report-ok");
  if (await okBtn.count()) await okBtn.click();
  const gone = await waitFor(async () => {
    const list = await page.evaluate(() => window.bookmark.list());
    return list.some((r) => r.id === ids["睡觉档第一条"]) ? null : true;
  }, 5000);
  check("⑦ 点报告里的「可以，删掉」→ 这条删掉", Boolean(gone));

  // 重开：还是睡觉档
  await app.close();
  ({ app } = await launch());
  page = await app.firstWindow();
  const t2 = await waitFor(async () => (await page.locator("#mode-btn").textContent().catch(() => ""))?.trim() || null, 5000);
  check("② 重开还是睡觉档", t2 === "🌙 睡觉档", `钮=${t2}`);
  await page.locator("#mode-btn").click();
  await waitFor(async () => ((await page.locator("#mode-btn").textContent())?.trim() === "☀️ 日常档" ? true : null), 5000);
  runCli(["release", ids["睡觉档第二条"], "--by", "Claude-7"]);
  const n3 = runCli(["next", "--to", "Claude", "--by", "Claude-8"]);
  check("⑧ 切回日常档，领活说明回到等用户说可以再 done", n3.code === 0 && n3.out.includes(`done ${ids["睡觉档第二条"]} --by Claude-8 --ok`) && !n3.out.includes("🌙 睡觉档") && !n3.out.includes(" report "), n3.out.slice(0, 200));
} catch (error) {
  failures.push(`脚本异常：${error?.message ?? error}`);
  console.error("脚本异常：", error);
} finally {
  try { await app?.close(); } catch { /* 关不掉就算了 */ }
  try { rmSync(hubHome, { recursive: true, force: true }); } catch { /* 临时目录清理失败无妨 */ }
}

if (failures.length) {
  console.error(`\n结果：${failures.length} 项没过 → ${failures.join("；")}`);
  process.exit(1);
}
console.log("\n结果：全部验证点通过");
