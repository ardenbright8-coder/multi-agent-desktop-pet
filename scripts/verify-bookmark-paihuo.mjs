// 派活单 + 一条一份小文件回归验证（Playwright·零抢鼠标）（2026-10-15 设定23、24，看板 Claude 01）：
//   ① 真命令 paihuo 写一批三张：没写组的进 Pi 组，写了 Claude 的进 Claude 组；没写「只许动」、超过三张都拒收
//   ② 派活单序号下面有分叉小标，碰到有说明（这一批还剩几张）；六个点里是「一键启动 3 个」，没有单开的「启动 Agent」
//   ③ 一键启动：测试实例不真开窗，只报会开哪几张（各在自己的组）
//   ④ 两张单子「只许动」撞了同一份文件：一个都不开，说清谁跟谁撞了哪份
//   ⑤ 真命令领一张：看到的是派活单规矩（交报告、不 done）和单独文件路径；同批剩两张，一键启动变「2 个」
//   ⑥ 点号码：复制这条单独文件的路径，文件里就是这条；删了这条，文件跟着没了
//   ⑦ 点标题进了改字、没选中字时按 Ctrl+X：剪的是这一整条
// 用法：npm run build 之后 node scripts/verify-bookmark-paihuo.mjs
// 注意：独立 AGENT_PET_HUB_HOME 起实例（不真开任何 AI 窗口）；会动系统剪贴板，开头存、结尾还原。

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const cliScript = join(root, "scripts", "bookmark-cli.mjs");
const home = mkdtempSync(join(tmpdir(), "bm-paihuo-"));
const out = join(root, ".runtime", "paihuo");
mkdirSync(out, { recursive: true });

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failed += 1;
}
function runCli(args) {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", env: { ...process.env, AGENT_PET_HUB_HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function writeCards(name, cards) {
  const path = join(home, name);
  writeFileSync(path, JSON.stringify({ cards }), "utf8");
  return path;
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
let saved = null;
try {
  app = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(root, "dist/app.js")], env: { ...process.env, AGENT_PET_HUB_HOME: home } });
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().includes("bookmark/renderer"));
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  await page.setViewportSize({ width: 560, height: 900 });
  saved = await app.evaluate(({ clipboard }) => clipboard.readText());
  const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  await waitFor(() => existsSync(join(home, "bookmark", "cli-port.json")));

  // ① 写一批
  const good = writeCards("批一.json", [
    { text: "派活甲：给 10 个夹补门牌", detail: "只许动：docs/a；docs/b\n验收：体检 0 报错" },
    { text: "派活乙：扫描脚本", detail: "只许动：scripts/scan.mjs" },
    { text: "派活丙：打包", detail: "只许动：release/", to: "Claude" },
  ]);
  const r1 = runCli(["paihuo", "--file", good]);
  check("① paihuo 写一批三张", r1.code === 0 && /3 张同一批/.test(r1.out), r1.out.trim().slice(0, 80));
  const bad = runCli(["paihuo", "--file", writeCards("缺只许动.json", [{ text: "没写只许动", detail: "随便" }])]);
  check("① 没写「只许动」：拒收", bad.code !== 0 && /只许动/.test(bad.out));
  const four = runCli(["paihuo", "--file", writeCards("四张.json", [1, 2, 3, 4].map((n) => ({ text: `${n}`, detail: "只许动：无" })))]);
  check("① 超过三张：拒收", four.code !== 0 && /最多 3 张/.test(four.out));

  await page.evaluate(() => bmRefresh());
  await page.locator("#tab-groups").click();
  const list = await page.evaluate(() => window.bookmark.list());
  const byText = (start) => list.find((r) => r.text.startsWith(start));
  const [A, B, C] = [byText("派活甲"), byText("派活乙"), byText("派活丙")];
  check("① 没写组的进 Pi 组、写了 Claude 的进 Claude 组、三张同一个批号",
    A.assignee === "Pi Agent" && B.assignee === "Pi Agent" && C.assignee === "Claude" && A.batchId && A.batchId === C.batchId, `${A.assignee}/${B.assignee}/${C.assignee}`);
  const T = (r) => `.task[data-id="${r.id}"]`;

  // ② 小标和菜单
  const badgeTitle = await page.locator(`${T(A)} .num-col .dispatch-badge`).getAttribute("title");
  check("② 序号下面有派活单小标，碰到说「这一批还有 3 张」", Boolean(badgeTitle) && /还有 3 张/.test(badgeTitle), badgeTitle ?? "");
  check("② 派活单小标不是表情（细线图标）", (await page.locator(`${T(A)} .dispatch-badge svg`).count()) === 1);
  await page.screenshot({ path: join(out, "派活单.png") });
  await page.locator(`${T(A)} .handle`).click();
  const menu = await page.locator("#ctx-menu").innerText();
  check("② 六个点里是「一键启动 3 个 · 带编程 / 普通」，没有单开的「启动 Agent」", /一键启动 3 个 · 带编程/.test(menu) && /一键启动 3 个 · 普通/.test(menu) && !/启动 Agent/.test(menu), menu.replace(/\s+/g, " "));

  // ③ 一键启动（测试实例不真开）
  await page.locator("#ctx-menu .ctx-item", { hasText: "一键启动 3 个 · 普通" }).click();
  const toast = await waitFor(async () => {
    const t = await page.locator("#bm-toast").innerText().catch(() => "");
    return /开了|没开/.test(t) ? t : "";
  }, 15000);
  check("③ 一键启动：报出三张各在自己的组（Pi Agent 01、02，Claude 01）", /Pi Agent 01/.test(toast) && /Pi Agent 02/.test(toast) && /Claude 01/.test(toast), toast);

  // ④ 撞文件
  runCli(["paihuo", "--file", writeCards("撞了.json", [
    { text: "撞甲", detail: "只许动：src/bookmark/renderer/bookmark.js" },
    { text: "撞乙", detail: "只许动：src/bookmark/renderer/" },
  ])]);
  await page.evaluate(() => bmRefresh());
  const list2 = await page.evaluate(() => window.bookmark.list());
  const X = list2.find((r) => r.text === "撞甲");
  await page.locator(`${T(X)} .handle`).click();
  await page.locator("#ctx-menu .ctx-item", { hasText: "一键启动 2 个 · 普通" }).click();
  const clash = await waitFor(async () => {
    const t = await page.locator("#bm-toast").innerText().catch(() => "");
    return /一个都没开/.test(t) ? t : "";
  });
  check("④ 撞了同一份文件：一个都不开，说清谁跟谁撞了", /一个都没开/.test(clash) && /都要动/.test(clash), clash);

  // ⑤ 真命令领一张
  const claim = runCli(["next", A.id, "--by", "PiAgent-77"]);
  check("⑤ 领到派活单：派活单规矩、交报告不 done、带单独文件路径", /【看板派活单】你是 PiAgent-77/.test(claim.out) && /report /.test(claim.out) && !/ done /.test(claim.out) && /单独文件/.test(claim.out));
  await page.evaluate(() => bmRefresh());
  await page.locator(`${T(B)} .handle`).click();
  check("⑤ 同批剩两张没人领：一键启动变「2 个」", /一键启动 2 个/.test(await page.locator("#ctx-menu").innerText()));
  await page.keyboard.press("Escape");
  await page.mouse.click(280, 880);

  // ⑥ 点号码复制单独文件路径；删了文件跟着没
  await page.locator(`${T(B)} .num`).click();
  const line = await waitFor(async () => {
    const t = await clip();
    return /单独文件/.test(t) ? t : "";
  });
  const path = (line.match(/：([A-Za-z]:.+\.md)$/) || [])[1];
  check("⑥ 点号码：复制的是这条单独文件的路径", Boolean(path) && existsSync(path), line);
  check("⑥ 文件里就是这条（含原文、只许动那行）", Boolean(path) && /派活乙：扫描脚本/.test(readFileSync(path, "utf8")) && /只许动：scripts\/scan\.mjs/.test(readFileSync(path, "utf8")));
  runCli(["remove", B.id]);
  check("⑥ 删了这条：单独文件跟着没了", Boolean(await waitFor(() => !existsSync(path), 4000)));

  // ⑦ 点标题进改字、没选中字时 Ctrl+X ＝剪整条
  await page.evaluate(() => bmRefresh());
  await page.locator(`${T(C)} .task-title`).click();
  await waitFor(() => page.evaluate(() => document.activeElement?.matches(".task-edit")));
  await page.keyboard.press("Control+x");
  await page.waitForTimeout(600);
  check("⑦ 改字时没选中字按 Ctrl+X：剪的是这一整条（变淡带虚线、改字框收起）",
    (await page.locator(`${T(C)}.clip-cut`).count()) === 1 && (await page.locator(".task-edit").count()) === 0);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(out, "结束.png") });
  console.log(failed ? `结果：${failed} 项没过` : "结果：全部验证点通过");
} finally {
  if (app) {
    if (saved !== null) {
      try { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved); } catch { /* 还原不了就算了 */ }
    }
    await app.close();
  }
}
process.exit(failed ? 1 : 0);
