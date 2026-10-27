// 按住条目拖出看板回归验证（Playwright·零抢鼠标）（2026-10-27 用户：按住条目本身拖进 Pi、Claude Code、浏览器，AI 一看就知道是哪条）：
//   ① 按住条目拖出窗口边：系统拖拽起来了，带的是「看板第 N 条的单独文件（只读这一份…）：路径」这行字，文件真在
//   ② 看板里挪位置那套作废：没留影子、条目没挪、没变成「拖完吞掉下一次点击」
//   ③ 字号 Ctrl 加减缩放过（125%）、按住序号拖，也照样起得来
//   ④ 没拖出窗口：照旧是看板里挪位置，不起系统拖拽
// 用法：npm run build 之后 node scripts/verify-bookmark-drag-out.mjs
// 注意：后台按不了真鼠标，系统拖拽在测试里一起来就拦掉（不然会放进鼠标底下别的窗口）；真拖进 Pi、Claude Code 要人手验。

import { createRequire } from "node:module";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const cliScript = join(root, "scripts", "bookmark-cli.mjs");
const home = mkdtempSync(join(tmpdir(), "bm-drag-out-"));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failed += 1;
}
function runCli(args) {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", env: { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

let app;
try {
  app = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(root, "dist/app.js")], env: { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home } });
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().includes("bookmark/renderer"));
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  await page.setViewportSize({ width: 560, height: 900 });
  await waitFor(() => existsSync(join(home, "bookmark", "cli-port.json")));

  runCli(["add", "拖出甲：按住我拖进 Claude Code", "--to", "Claude"]);
  runCli(["add", "拖出乙：放大字号再拖", "--to", "Claude"]);
  await page.evaluate(() => bmRefresh());
  await page.locator("#tab-groups").click();
  const list = await page.evaluate(() => window.bookmark.list());
  const [A, B] = ["拖出甲", "拖出乙"].map((s) => list.find((r) => r.text.startsWith(s)));
  const T = (r) => `.task[data-id="${r.id}"]`;

  // 系统拖拽一起来就记下带了什么、当场拦掉（冒泡到 window 时看板自己的 dragstart 已经填好字）
  await page.evaluate(() => {
    window.__dragOut = [];
    window.addEventListener("dragstart", (event) => {
      window.__dragOut.push({ text: event.dataTransfer.getData("text/plain"), carrier: event.target.classList.contains("drag-out-carrier") });
      event.preventDefault();
    });
  });
  const order = () => page.evaluate(() => [...document.querySelectorAll(".task")].map((el) => el.dataset.id));

  async function dragOut(record, toX, part = ".task-title") {
    const box = await page.locator(`${T(record)} ${part}`).boundingBox();
    await page.evaluate(() => { window.__dragOut = []; });
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 12, y, { steps: 3 });
    await page.mouse.move(toX, y, { steps: 6 });
    const got = await waitFor(() => page.evaluate(() => window.__dragOut.at(-1) ?? null), 3000);
    await page.mouse.up();
    return got;
  }

  // ① ②
  const before = await order();
  const noA = await page.locator(`${T(A)} .num`).innerText();
  const noB = await page.locator(`${T(B)} .num`).innerText();
  const got = await dragOut(A, -40);
  const path = ((got?.text ?? "").match(/：([A-Za-z]:.+\.md)$/) || [])[1];
  check("① 拖出窗口边：系统拖拽起来了，起在看板摆的小块上", Boolean(got?.carrier), JSON.stringify(got));
  check(`① 带的是「看板第 ${noA} 条…的单独文件（只读这一份，别翻整组）：路径」`, (got?.text ?? "").startsWith(`看板第 ${noA} 条`) && /的单独文件（只读这一份，别翻整组）：/.test(got?.text ?? ""), got?.text);
  check("① 路径指的文件真在、就是这一条", Boolean(path) && existsSync(path) && path.includes(A.id), path);
  await page.waitForTimeout(300);
  const after = await order();
  check("② 看板里没留影子、没多出同号的复制品、条目没挪位置", (await page.locator(".drag-ghost").count()) === 0 && JSON.stringify(after) === JSON.stringify(before), `前 ${before.join(",")} 后 ${after.join(",")}`);
  check("② 拖出去以后没留着「吞掉下一次点击」", await page.locator(T(A)).evaluate((el) => el.dataset.swallow !== "1"));
  await page.mouse.click(5, 5);
  check("② 小块和拖拽图收干净了", (await page.locator(".drag-out-carrier, .drag-out-image").count()) === 0);

  // ③ 字号 125%
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { if (w.webContents.getURL().includes("bookmark/renderer")) w.webContents.setZoomFactor(1.25); }));
  await page.waitForTimeout(400);
  const vw = await page.evaluate(() => window.innerWidth);
  const got2 = await dragOut(B, vw + 40, ".num");
  check(`③ 字号 125%、按住序号从右边拖出去：照样起来、是第 ${noB} 条`, Boolean(got2?.carrier) && (got2?.text ?? "").startsWith(`看板第 ${noB} 条`), got2?.text);
  await page.mouse.click(5, 5);

  // ④ 没出窗口：照旧在看板里挪
  await page.evaluate(() => { window.__dragOut = []; });
  const boxA = await page.locator(`${T(A)} .task-title`).boundingBox();
  const boxB = await page.locator(`${T(B)} .task-title`).boundingBox();
  await page.mouse.move(boxA.x + 20, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxA.x + 20, boxB.y + boxB.height + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  check("④ 没拖出窗口：不起系统拖拽", (await page.evaluate(() => window.__dragOut.length)) === 0);
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  await app?.close().catch(() => {});
}
console.log(failed ? `\n✖ ${failed} 项没过` : "\n✔ 全部通过");
process.exit(failed ? 1 : 0);
