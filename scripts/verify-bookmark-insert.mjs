// 书签看板「点加号冒出来的输入行」回归验证（Playwright·零抢鼠标）。
// 病根（2026-09-24 用户报：点了加号冒出空行，点别处关不掉）：先拿数据再画框，放光标那一步抢在框画出来之前，
//   光标没进框 → 点别处没有「离开」这回事 → 收不起来。单击文字进改字同一个写法。
// 2026-09-24 改：每组第一格永远是空白框，组名旁的小加号拿掉（用户：不用再按加号）。
// 验证点：
//   ① 待定区第一格是空白框、组名旁没有小加号
//   ② 点空白框光标进框；不写字点别处 → 不多出条目、空白框还在
//   ③ 写了字点别处 → 这条挪到第二格，第一格又是空的；③b 回车同样挪下去，光标留在空白框能接着写
//   ④ 单击条目文字进改字，光标在改字框里；点别处收起
//   ⑤ 交接单专区保留小加号，点了能手写一张交接单（带 📋，落在专区）
//   ⑥ 打字中途看板重画，光标还在空白框里、字不丢
//   ⑦ 分组页每个 agent 组第一格都是空白框、没有小加号；写进哪组落在哪组
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
  await waitFor(async () => (await panel.locator("#board .task:not(.insert-row)").count()) === 1);

  const inbox = '#board .group[data-group="__inbox__"]';
  const focusedInInsert = () => panel.evaluate(() => {
    const el = document.activeElement;
    return !!el && el.tagName === "TEXTAREA" && !!el.closest(".insert-row");
  });
  const blank = `${inbox} .insert-row.blank-row textarea`;
  const taskCount = () => panel.evaluate(() => document.querySelectorAll("#board .task:not(.insert-row)").length);
  const focusedInBlank = () => panel.evaluate(() => {
    const el = document.activeElement;
    return !!el && el.tagName === "TEXTAREA" && !!el.closest(".blank-row");
  });
  const blankValue = () => panel.locator(blank).inputValue();
  const firstTwo = () => panel.evaluate((sel) => {
    const rows = [...document.querySelectorAll(`${sel} .task-list > li`)];
    return rows.slice(0, 2).map((el) => (el.classList.contains("blank-row") ? "[空白框]" : el.querySelector(".task-text")?.textContent ?? "?"));
  }, inbox);
  const clickElsewhere = () => panel.locator("#titlebar .title").click();

  // ① 第一格永远是空白框，组名旁没有小加号（2026-09-24 用户：不用再按加号）
  const shape = await firstTwo();
  const inboxAdd = await panel.locator(`${inbox} .g-add`).count();
  check("① 待定区第一格是空白框、第二格是原有那条，组名旁没有小加号",
    shape[0] === "[空白框]" && shape[1] === "原有一条" && inboxAdd === 0, `前两格=${JSON.stringify(shape)} 加号=${inboxAdd}`);

  // ② 点空白框，光标进框；不写字点别处 → 不多出条目，空白框还在
  await panel.locator(blank).click();
  const focused = await waitFor(focusedInBlank, 1500, 50);
  check("② 点空白框，光标就在框里", !!focused);
  await clickElsewhere();
  await sleep(300);
  check("② 不写字点别处，不多出条目、空白框还在", (await taskCount()) === 1 && (await panel.locator(blank).count()) === 1,
    `条目=${await taskCount()}`);

  // ③ 写了字：边写边存（看板上第二格现身），点别处 → 空白框清空，这条留在第二格
  await panel.locator(blank).click();
  await waitFor(focusedInBlank, 1500, 50);
  await panel.keyboard.type("点别处");
  // ⑥ 打字中途看板重画（窗口拿焦点、手机来消息都会重画）：光标还在框里，字不丢
  await panel.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await sleep(400);
  const kept = await panel.evaluate(() => {
    const el = document.activeElement;
    return { inBlank: !!el && !!el.closest && !!el.closest(".blank-row"), value: el && "value" in el ? el.value : "" };
  });
  check("⑥ 打字中途看板重画，光标还在空白框里、字不丢", kept.inBlank && kept.value === "点别处", JSON.stringify(kept));
  await panel.keyboard.type("也存");
  await clickElsewhere();
  const moved = await waitFor(async () => {
    const two = await firstTwo();
    return two[0] === "[空白框]" && two[1] === "点别处也存" && (await blankValue()) === "" ? two : null;
  }, 3000);
  check("③ 写了字点别处：这条挪到第二格，第一格又是空的", !!moved && (await taskCount()) === 2, `前两格=${JSON.stringify(await firstTwo())}`);

  // ③b 回车：这条挪到第二格，光标还在空白框里，能接着写下一条
  await panel.locator(blank).click();
  await waitFor(focusedInBlank, 1500, 50);
  await panel.keyboard.type("回车记下");
  await panel.keyboard.press("Enter");
  const afterEnter = await waitFor(async () => {
    const two = await firstTwo();
    return two[1] === "回车记下" && (await blankValue()) === "" ? two : null;
  }, 3000);
  const stillIn = await waitFor(focusedInBlank, 1500, 50);
  check("③b 回车：这条挪到第二格，第一格清空、光标还在里面能接着写", !!afterEnter && !!stillIn && (await taskCount()) === 3,
    `前两格=${JSON.stringify(await firstTwo())} 光标在框里=${!!stillIn}`);
  await panel.keyboard.type("接着写");
  await panel.keyboard.press("Enter");
  const next = await waitFor(async () => ((await firstTwo())[1] === "接着写" ? true : null), 3000);
  check("③b 接着写的第二条也挪下去了", !!next && (await taskCount()) === 4, `前两格=${JSON.stringify(await firstTwo())}`);
  await clickElsewhere();

  // ④ 单击文字进改字 → 光标在改字框；点别处收起
  await panel.locator("#board .task .task-text", { hasText: "原有一条" }).click();
  await waitFor(async () => (await panel.locator("#board .task-edit").count()) === 1, 3000);
  const editFocused = await waitFor(async () => panel.evaluate(() => document.activeElement?.classList.contains("task-edit") ?? false), 1500, 50);
  check("④ 单击文字进改字，光标在改字框里", !!editFocused);
  await clickElsewhere();
  const editClosed = await waitFor(async () => (await panel.locator("#board .task-edit").count()) === 0, 2000);
  check("④ 改字时点别处，改字框收起", !!editClosed);

  // ⑦ 分组页：每个 agent 组第一格都是空白框、没有小加号；写进 Claude 组的就落在 Claude 组
  await panel.locator("#tab-groups").click();
  await waitFor(async () => (await panel.locator("#board .group.handoff-zone").count()) === 1);
  const groupsShape = await panel.evaluate(() => [...document.querySelectorAll("#board .group:not(.handoff-zone)")].map((g) => ({
    name: g.dataset.group,
    blankFirst: !!g.querySelector(".task-list > li:first-child.blank-row"),
    add: g.querySelectorAll(".group-head .g-add").length,
  })));
  check("⑦ 分组页每个 agent 组第一格都是空白框、组名旁没有小加号",
    groupsShape.length >= 4 && groupsShape.every((g) => g.blankFirst && g.add === 0), JSON.stringify(groupsShape));
  await panel.locator('#board .group[data-group="Claude"] .insert-row.blank-row textarea').click();
  await panel.keyboard.type("给Claude的");
  await panel.keyboard.press("Enter");
  const inClaude = await waitFor(async () => panel.evaluate(() => {
    const g = document.querySelector('#board .group[data-group="Claude"]');
    return [...g.querySelectorAll(".task .task-text")].some((el) => el.textContent === "给Claude的");
  }), 3000);
  check("⑦ 在 Claude 组空白框写的，落在 Claude 组", !!inClaude);
  await clickElsewhere();
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
