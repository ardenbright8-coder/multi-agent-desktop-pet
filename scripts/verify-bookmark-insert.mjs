// 书签看板「点加号冒出来的输入行」回归验证（Playwright·零抢鼠标）。
// 病根（2026-09-24 用户报：点了加号冒出空行，点别处关不掉）：先拿数据再画框，放光标那一步抢在框画出来之前，
//   光标没进框 → 点别处没有「离开」这回事 → 收不起来。单击文字进改字同一个写法。
// 验证点：
//   ① 点加号，光标直接在输入框里
//   ② 不写字点别处 → 输入行收起，不多出条目
//   ③ 写了字点别处 → 存成一条，输入行收起
//   ④ 单击条目文字进改字，光标在改字框里；点别处收起
//   ⑤ 交接单专区有同款小加号，点了能手写一张交接单（带 📋，落在专区）
//   ⑥ 打字中途看板重画，光标还在框里、字不丢
// 用法：npm run build 之后 node scripts/verify-bookmark-insert.mjs

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hubHome = mkdtempSync(join(tmpdir(), "bm-insert-verify-"));
let electronApp;
try {
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome },
  });
  const panel = await waitFor(async () => {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) return win;
    }
    return null;
  });
  if (!panel) throw new Error("书签面板窗口没出现");
  await panel.waitForLoadState("domcontentloaded");

  await panel.evaluate(() => window.bookmark.add({ text: "原有一条" }));
  await panel.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await waitFor(async () => (await panel.locator("#board .task").count()) === 1);

  const inbox = '#board .group[data-group="__inbox__"]';
  const rowOpen = () => panel.locator("#board .insert-row").count();
  const taskCount = () => panel.evaluate(() => document.querySelectorAll("#board .task:not(.insert-row)").length);
  const focusedInInsert = () => panel.evaluate(() => {
    const el = document.activeElement;
    return !!el && el.tagName === "TEXTAREA" && !!el.closest(".insert-row");
  });
  const clickElsewhere = () => panel.locator("#titlebar .title").click();

  // ①② 点加号 → 光标进框；不写字点别处 → 收起、不多条目
  await panel.locator(`${inbox} .g-add`).click();
  await waitFor(async () => (await rowOpen()) === 1, 3000);
  const focused = await waitFor(focusedInInsert, 1500, 50);
  check("① 点加号，光标直接在输入框里", !!focused);
  await clickElsewhere();
  const closed = await waitFor(async () => (await rowOpen()) === 0, 2000);
  check("② 不写字点别处，输入行收起", !!closed, `输入行=${await rowOpen()}`);
  check("② 不写字点别处，不多出条目", (await taskCount()) === 1, `条目=${await taskCount()}`);

  // ③ 写了字点别处 → 存成一条、收起
  await panel.locator(`${inbox} .g-add`).click();
  await waitFor(async () => (await rowOpen()) === 1, 3000);
  await waitFor(focusedInInsert, 1500, 50);
  await panel.keyboard.type("点别处");
  // ⑥ 打字中途看板重画（窗口拿焦点、手机来消息都会重画）：光标还在框里，字不丢
  await panel.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await sleep(400);
  const kept = await panel.evaluate(() => {
    const el = document.activeElement;
    return { inBox: !!el && !!el.closest && !!el.closest(".insert-row"), value: el && "value" in el ? el.value : "" };
  });
  check("⑥ 打字中途看板重画，光标还在框里、字不丢", kept.inBox && kept.value === "点别处", JSON.stringify(kept));
  await panel.keyboard.type("也存");
  await clickElsewhere();
  const saved = await waitFor(async () => (await rowOpen()) === 0 && (await taskCount()) === 2, 3000);
  const texts = await panel.evaluate(() => [...document.querySelectorAll("#board .task .task-text")].map((el) => el.textContent));
  check("③ 写了字点别处，存成一条并收起", !!saved && texts.includes("点别处也存"), `条目=${texts.join("/")}`);

  // ④ 单击文字进改字 → 光标在改字框；点别处收起
  await panel.locator("#board .task .task-text", { hasText: "原有一条" }).click();
  await waitFor(async () => (await panel.locator("#board .task-edit").count()) === 1, 3000);
  const editFocused = await waitFor(async () => panel.evaluate(() => document.activeElement?.classList.contains("task-edit") ?? false), 1500, 50);
  check("④ 单击文字进改字，光标在改字框里", !!editFocused);
  await clickElsewhere();
  const editClosed = await waitFor(async () => (await panel.locator("#board .task-edit").count()) === 0, 2000);
  check("④ 改字时点别处，改字框收起", !!editClosed);

  // ⑤ 交接单专区的小加号
  await panel.locator("#tab-groups").click();
  const zone = "#board .group.handoff-zone";
  await waitFor(async () => (await panel.locator(zone).count()) === 1);
  const zoneAdd = await panel.locator(`${zone} .g-add`).count();
  check("⑤ 交接单专区有小加号", zoneAdd === 1, `加号=${zoneAdd}`);
  if (zoneAdd === 1) {
    await panel.locator(`${zone} .g-add`).click();
    await waitFor(async () => (await panel.locator(`${zone} .insert-row`).count()) === 1, 3000);
    await waitFor(focusedInInsert, 1500, 50);
    await panel.keyboard.type("手写的交接单");
    await panel.keyboard.press("Enter");
    const handoff = await waitFor(async () => panel.evaluate((sel) => {
      const task = [...document.querySelectorAll(`${sel} .task`)].find((el) => el.textContent.includes("手写的交接单"));
      return task ? { badge: task.classList.contains("handoff") && !!task.querySelector(".handoff-badge") } : null;
    }, zone), 3000);
    check("⑤ 点专区加号能手写一张交接单（带 📋、落在专区）", !!handoff && handoff.badge, JSON.stringify(handoff));
  }
} catch (error) {
  failures.push(`脚本异常：${error?.message ?? error}`);
  console.error("脚本异常：", error);
} finally {
  try { await electronApp?.close(); } catch { /* 关不掉就算了 */ }
  try { rmSync(hubHome, { recursive: true, force: true }); } catch { /* 临时目录清理失败无妨 */ }
}

if (failures.length) {
  console.error(`\n结果：${failures.length} 项没过 → ${failures.join("；")}`);
  process.exit(1);
}
console.log("\n结果：全部验证点通过");
