// 书签看板「复制给 AI」回归验证（Playwright·零抢鼠标）（2026-09-24 用户拍板）：
//   ① 行尾复制钮平时藏着，鼠标移到这一行才露
//   ② 点复制钮弹气泡：模板夹里每份 md 一项 + 「只复制这条」+ 底下「改要求…」
//   ③ 选「带编程那套」→ 剪贴板 = 模板原文 + 「## 这次的事」+ 这条（期望答案在本脚本里独立拼，不调被测函数）
//   ④ 选「只复制这条」→ 剪贴板只有这条；选完气泡收起、弹「已复制」
//   ⑤ 点气泡外面收起
//   ⑥ 右键菜单：分组页不再列「派给 →」（拖到组头就是派），「收回待定」「删除这条」还在；待定页照旧有「派给 →」
//   ⑦ 组头 ＋ / 收起换成细线图标（svg，不再是字符），不大于 22 像素
// 用法：npm run build 之后 node scripts/verify-bookmark-copy.mjs
// 注意：用独立 AGENT_PET_HUB_HOME 起实例；会动系统剪贴板，脚本开头存、结尾还原。

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const projectRoot = resolve(import.meta.dirname, "..");
const electronExe = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const appEntry = join(projectRoot, "dist", "app.js");

const failures = [];
function check(name, ok, detail = "") {
  const mark = ok ? "✔" : "✘";
  console.log(`${mark} ${name}${detail ? `（${detail}）` : ""}`);
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

const TEMPLATE = "# 总要求\n\n先读工作流，再动手。";
const hubHome = mkdtempSync(join(tmpdir(), "bm-copy-verify-"));
mkdirSync(join(hubHome, "bookmark", "要求模板"), { recursive: true });
writeFileSync(join(hubHome, "bookmark", "要求模板", "带编程那套.md"), TEMPLATE + "\n", "utf8");

let electronApp;
let savedClipboard = null;
try {
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome },
  });
  savedClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const readClipboard = () => electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const panel = await waitFor(async () => {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) return win;
    }
    return null;
  });
  if (!panel) throw new Error("书签面板窗口没出现");
  await panel.waitForLoadState("domcontentloaded");

  await panel.evaluate(async () => {
    const a = await window.bookmark.add({ text: "脑图搜索框看不见" });
    await window.bookmark.setAssignee(a.id, "Claude");
    await window.bookmark.add({ text: "待定里的一条" });
  });
  await panel.locator("#tab-groups").click();
  const row = panel.locator('#board .group[data-group="Claude"] .task').first();
  await row.waitFor({ state: "visible", timeout: 5000 });
  const copyBtn = row.locator(".t-copy");

  // ① 平时藏着，移上去才露
  const opacity = () => copyBtn.evaluate((el) => getComputedStyle(el).opacity);
  await panel.mouse.move(2, 2);
  const hiddenOpacity = await opacity();
  await row.hover();
  const shownOpacity = await waitFor(async () => ((await opacity()) === "1" ? "1" : null), 2000, 50);
  check("① 复制钮平时藏着，移到这一行才露", hiddenOpacity === "0" && shownOpacity === "1",
    `平时=${hiddenOpacity} 移上去=${shownOpacity}`);

  // ② 气泡内容
  await copyBtn.click();
  const pop = panel.locator("#copy-pop");
  await pop.waitFor({ state: "visible", timeout: 3000 });
  const labels = await pop.locator(".ctx-item").allTextContents();
  const foot = await pop.locator(".copy-pop-foot").textContent();
  check("② 气泡 = 模板一项 +「只复制这条」+「改要求…」",
    JSON.stringify(labels) === JSON.stringify(["带编程那套", "只复制这条"]) && foot === "改要求…",
    `选项=${JSON.stringify(labels)} 底=${foot}`);

  // ③ 带模板
  await pop.locator(".ctx-item", { hasText: "带编程那套" }).click();
  const expectedFull = TEMPLATE + "\n\n## 这次的事\n\n脑图搜索框看不见";
  const full = await waitFor(async () => ((await readClipboard()) === expectedFull ? expectedFull : null), 3000, 50);
  check("③ 带编程那套：剪贴板 = 模板 +「这次的事」+ 这条", full === expectedFull,
    `实际=${JSON.stringify(await readClipboard())}`);

  // ④ 只复制这条；选完气泡收起、弹提示
  const popHiddenAfterPick = await pop.isHidden();
  const toast = await panel.locator("#bm-toast").textContent();
  check("④ 选完气泡收起、弹「已复制」", popHiddenAfterPick && (toast ?? "").includes("已复制"), `提示=${toast}`);
  await row.hover();
  await copyBtn.click();
  await pop.locator(".ctx-item", { hasText: "只复制这条" }).click();
  const plain = await waitFor(async () => ((await readClipboard()) === "脑图搜索框看不见" ? "ok" : null), 3000, 50);
  check("④ 只复制这条：剪贴板只有这条", plain === "ok", `实际=${JSON.stringify(await readClipboard())}`);

  // ⑤ 点外面收起
  await row.hover();
  await copyBtn.click();
  await pop.waitFor({ state: "visible", timeout: 3000 });
  await panel.locator("#titlebar .title").click();
  check("⑤ 点气泡外面收起", await waitFor(async () => pop.isHidden(), 2000, 50));

  // ⑥ 右键菜单
  await row.click({ button: "right" });
  const menu = panel.locator("#ctx-menu");
  await menu.waitFor({ state: "visible", timeout: 3000 });
  const groupMenu = await menu.innerText();
  check("⑥ 分组页右键：没有「派给 →」，「收回待定」「删除这条」还在",
    !groupMenu.includes("派给") && !groupMenu.includes("ChatGPT") && groupMenu.includes("收回待定") && groupMenu.includes("删除这条"),
    JSON.stringify(groupMenu));
  await panel.keyboard.press("Escape");
  await panel.locator("#titlebar .title").click();
  await panel.locator("#tab-inbox").click();
  const inboxRow = panel.locator("#board .task").first();
  await inboxRow.waitFor({ state: "visible", timeout: 3000 });
  await inboxRow.click({ button: "right" });
  await menu.waitFor({ state: "visible", timeout: 3000 });
  const inboxMenu = await menu.innerText();
  check("⑥ 待定页右键：照旧有「派给 →」和各组", inboxMenu.includes("派给") && inboxMenu.includes("Claude"),
    JSON.stringify(inboxMenu));
  await panel.locator("#titlebar .title").click();

  // ⑦ 组头细线图标（2026-09-24 折叠钮已撤，组头只剩小加号）
  await panel.locator("#tab-groups").click();
  const head = await panel.locator('#board .group[data-group="Claude"] .group-head').evaluate((el) => {
    const add = el.querySelector(".g-add");
    return {
      svg: !!add?.querySelector("svg"),
      text: add?.textContent ?? "",
      size: add?.getBoundingClientRect().width ?? 99,
    };
  });
  check("⑦ 组头 ＋ 是细线图标、不大于 22 像素", head.svg && head.text.trim() === "" && head.size <= 22,
    JSON.stringify(head));
} catch (error) {
  failures.push(`脚本异常：${error?.message ?? error}`);
  console.error("脚本异常：", error);
} finally {
  if (savedClipboard !== null) {
    try { await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard); } catch { /* 还原不了就算了 */ }
  }
  try { await electronApp?.close(); } catch { /* 关不掉就算了 */ }
  try { rmSync(hubHome, { recursive: true, force: true }); } catch { /* 临时目录清理失败无妨 */ }
}

if (failures.length) {
  console.error(`\n结果：${failures.length} 项没过 → ${failures.join("；")}`);
  process.exit(1);
}
console.log("\n结果：全部验证点通过");
