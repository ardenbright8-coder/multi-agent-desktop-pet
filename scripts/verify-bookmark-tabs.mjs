// 书签看板「待定/分组」两页签切换的后台驱动验证（Playwright·零抢鼠标）。
// 四个验证点：①页签切换互斥 ②待定角标数字对 ③分页下记一条/右键改派照常 ④默认页是待定。
// 用法：node scripts/verify-bookmark-tabs.mjs
// 注意：用独立 AGENT_PET_HUB_HOME 起实例（跟真 dev 并存、空书签库、收信模块静默不启动），用完关闭并清理。

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

/** 轮询到 fn 返回值 === expected 为止；超时返回最后一个实际值（给 check 当证据）。 */
async function waitForValue(fn, expected, timeoutMs = 8000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

const hubHome = mkdtempSync(join(tmpdir(), "bm-tabs-verify-"));
let electronApp;
try {
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome },
  });
  // 多窗口应用：按 URL 挑书签面板（别拿 firstWindow——那是桌宠本体的）。
  const panel = await waitFor(async () => {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) return win;
    }
    return null;
  });
  if (!panel) throw new Error("书签面板窗口没出现");
  await panel.waitForLoadState("domcontentloaded");

  // ④ 默认页是待定：inbox 页签 active，board 里只有待定组。
  const defaultPage = await panel.evaluate(() => ({
    inboxActive: document.getElementById("tab-inbox")?.classList.contains("active") ?? false,
    groupsActive: document.getElementById("tab-groups")?.classList.contains("active") ?? false,
    inboxGroupInBoard: !!document.querySelector('#board .group[data-group="__inbox__"]'),
    agentGroupsInBoard: document.querySelectorAll('#board .group:not([data-group="__inbox__"])').length,
  }));
  check("④ 默认页是待定（inbox 页签 active）", defaultPage.inboxActive && !defaultPage.groupsActive,
    `inbox=${defaultPage.inboxActive} groups=${defaultPage.groupsActive}`);
  check("④ 默认页 board 里只有待定组、无 agent 分组", defaultPage.inboxGroupInBoard && defaultPage.agentGroupsInBoard === 0,
    `待定组=${defaultPage.inboxGroupInBoard} 分组数=${defaultPage.agentGroupsInBoard}`);

  // ② 空库角标是 0。
  const badge0 = await panel.evaluate(() => document.getElementById("tab-inbox-count")?.textContent ?? null);
  check("② 空库时待定角标 = 0", badge0 === "0", `实际=${badge0}`);

  // ③ 记一条：待定组第一格空白框里输入 → Enter（2026-09-24 起不用先点 ＋）。
  await panel.locator('#board .group[data-group="__inbox__"] .blank-row textarea').fill("后台驱动验证·第一条");
  await panel.locator('#board .group[data-group="__inbox__"] .blank-row textarea').press("Enter");
  const badge1 = await waitForValue(
    async () => panel.evaluate(() => document.getElementById("tab-inbox-count")?.textContent),
    "1",
  );
  check("② 记一条后角标 = 1", badge1 === "1", `实际=${badge1}`);

  // 再记一条 → 角标 2。
  await panel.locator('#board .group[data-group="__inbox__"] .blank-row textarea').fill("后台驱动验证·第二条");
  await panel.locator('#board .group[data-group="__inbox__"] .blank-row textarea').press("Enter");
  const badge2 = await waitForValue(
    async () => panel.evaluate(() => document.getElementById("tab-inbox-count")?.textContent),
    "2",
  );
  check("② 记两条后角标 = 2", badge2 === "2", `实际=${badge2}`);

  // ③ 右键改派照常：点第一条手柄 → 菜单点 Claude → 条目从待定消失。
  await panel.locator('#board .group[data-group="__inbox__"] .task .handle').first().click();
  await panel.locator("#ctx-menu .ctx-item", { hasText: "Claude" }).first().click();
  const badgeAfterReassign = await waitForValue(
    async () => panel.evaluate(() => document.getElementById("tab-inbox-count")?.textContent),
    "1",
  );
  check("③ 改派给 Claude 后待定角标 = 1（改派照常工作）", badgeAfterReassign === "1", `实际=${badgeAfterReassign}`);

  // ① 切到分组页：agent 分组出现（Claude 组里有刚才那条）、待定组不在 DOM。
  await panel.locator("#tab-groups").click();
  const groupsPage = await waitFor(async () => {
    const state = await panel.evaluate(() => ({
      groupsActive: document.getElementById("tab-groups")?.classList.contains("active") ?? false,
      inboxGroupInBoard: !!document.querySelector('#board .group[data-group="__inbox__"]'),
      claudeTasks: document.querySelectorAll('#board .group[data-group="Claude"] .task').length,
      addAgentVisible: !document.getElementById("add-agent-btn").hidden,
    }));
    return state.groupsActive && !state.inboxGroupInBoard ? state : null;
  });
  check("① 点「Agent 分组」后分组页显示、待定组从 board 消失（互斥）",
    !!groupsPage && !groupsPage.inboxGroupInBoard, JSON.stringify(groupsPage));
  check("③ 分组页里 Claude 组有刚改派的那条", (groupsPage?.claudeTasks ?? 0) === 1,
    `Claude 组条数=${groupsPage?.claudeTasks}`);
  check("① 分组页显示「＋加Agent」", groupsPage?.addAgentVisible === true);

  // ① 切回待定页：互斥的另一边。
  await panel.locator("#tab-inbox").click();
  const backToInbox = await waitFor(async () => {
    const state = await panel.evaluate(() => ({
      inboxActive: document.getElementById("tab-inbox")?.classList.contains("active") ?? false,
      inboxGroupInBoard: !!document.querySelector('#board .group[data-group="__inbox__"]'),
      tasks: document.querySelectorAll('#board .group[data-group="__inbox__"] .task').length,
      addAgentVisible: !document.getElementById("add-agent-btn").hidden,
    }));
    return state.inboxActive && state.inboxGroupInBoard ? state : null;
  });
  check("① 点回「待定」后待定页显示、分组从 board 消失（互斥）",
    !!backToInbox && backToInbox.inboxGroupInBoard, JSON.stringify(backToInbox));
  check("① 待定页剩 1 条（改派走了一条）", backToInbox?.tasks === 1, `条数=${backToInbox?.tasks}`);
  check("① 待定页隐藏「＋加Agent」", backToInbox?.addAgentVisible === false);
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
