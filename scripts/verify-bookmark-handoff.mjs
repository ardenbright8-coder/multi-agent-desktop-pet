// 书签看板「AI 交接单专区」后台驱动验证（Playwright·零抢鼠标）。
// 验证点：①未派发交接单默认落 Agent分组页最底部的 📋专区（不进待定，专区垫底在＋加Agent上方）
//        ②条目显眼（📋 标记+handoff 样式），普通条目没有  ③详情默认收起、点开可展开可收起
//        ④拖到哪个组=派给谁（组内现形+assignee 落库）；CLI 带 --to 的直接进组不进专区
//        ⑤收回回专区 ⑥remove 自删后条目消失。
// 用法：node scripts/verify-bookmark-handoff.mjs（独立 AGENT_PET_HUB_HOME，不碰真库）。

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

const hubHome = mkdtempSync(join(tmpdir(), "bm-handoff-verify-"));
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

  // 准备：待定区记一条普通条目 + 直接写一条未派发交接单（走 bookmark:add 的 kind/detail 字段，
  // 与 CLI handoff 不带 --to 同一条管道同一种落位）。
  // 注意：直调 IPC 不会触发面板刷新（真机路径都各自刷），所以这里补 bmRefresh()。
  await panel.evaluate(() => window.bookmark.add({ text: "普通条目一条" }));
  await panel.evaluate(() => window.bookmark.add({
    text: "分页改完，交给你验收",
    kind: "handoff",
    detail: "做了：两页签+角标。交出来：renderer 三件套。下一步：手机端待拍板。",
  }));
  await panel.evaluate(() => bmRefresh());
  // 默认页是待定：普通条目在，交接单不该出现在待定区。
  await waitFor(async () => {
    return panel.evaluate(() => document.querySelectorAll('#board .group[data-group="__inbox__"] .task').length === 1);
  });
  const inboxState = await panel.evaluate(() => {
    const tasks = [...document.querySelectorAll('#board .group[data-group="__inbox__"] .task')];
    return {
      count: tasks.length,
      texts: tasks.map((t) => t.querySelector(".task-text")?.textContent ?? ""),
      badgeCount: document.querySelectorAll('#board .group[data-group="__inbox__"] .handoff-badge').length,
    };
  });
  check("① 未派发交接单不进待定区（待定只剩普通条目）", inboxState.count === 1 && inboxState.texts[0]?.includes("普通条目"),
    JSON.stringify(inboxState));

  // 切到 Agent分组页：专区在最底部、＋加Agent 按钮上方，交接单在专区里。
  await panel.locator("#tab-groups").click();
  const zoneState = await waitFor(async () => {
    return panel.evaluate(() => {
      const board = document.getElementById("board");
      const zone = board?.querySelector(".group.handoff-zone");
      if (!zone) return null;
      return {
        isLastSection: board.lastElementChild === zone,
        taskCount: zone.querySelectorAll(".task").length,
        text: zone.querySelector(".task-text")?.textContent ?? "",
        zoneName: zone.querySelector(".group-name")?.textContent ?? "",
        zoneCount: zone.querySelector(".group-count")?.textContent ?? "",
        addAgentBtnAboveZone: (() => {
          // ＋加Agent 按钮在底栏 #board-foot 里，#board 整体在它上方；专区是 #board 最后一块 = 紧挨按钮上方。
          const btn = document.getElementById("add-agent-btn");
          return !!btn && !btn.hidden && zone.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING;
        })(),
      };
    });
  });
  check("① Agent分组页有交接单专区且是最后一块（＋加Agent 按钮上方）",
    !!zoneState && zoneState.isLastSection && zoneState.addAgentBtnAboveZone, JSON.stringify(zoneState));
  check("① 交接单默认落在专区里（1 条）", zoneState?.taskCount === 1 && zoneState.text.includes("分页改完"),
    `专区名=${zoneState?.zoneName} 计数=${zoneState?.zoneCount}`);

  // ② 显眼标记：专区条目带 handoff 样式+📋 徽标。
  const mark = await panel.evaluate(() => {
    const task = document.querySelector('.group.handoff-zone .task');
    return {
      isHandoff: task?.classList.contains("handoff") ?? false,
      badge: task?.querySelector(".handoff-badge")?.textContent ?? "",
    };
  });
  check("② 专区条目带 handoff 样式+📋标记", mark.isHandoff && mark.badge.includes("📋"), JSON.stringify(mark));

  // ③ 详情默认收起，点条目展开看到详情文本，再点收起。
  const detailHiddenBefore = await panel.evaluate(() => {
    const task = document.querySelector(".group.handoff-zone .task");
    return task?.querySelector(".task-detail")?.hidden ?? null;
  });
  check("③ 详情默认收起", detailHiddenBefore === true, `hidden=${detailHiddenBefore}`);
  await panel.locator(".group.handoff-zone .task.has-detail .task-body").first().click();
  const detailShown = await panel.evaluate(() => {
    const detail = document.querySelector(".group.handoff-zone .task .task-detail");
    return { hidden: detail?.hidden ?? null, text: detail?.textContent?.includes("手机端待拍板") ?? false };
  });
  check("③ 点条目展开详情看到详情文本", detailShown.hidden === false && detailShown.text, JSON.stringify(detailShown));
  await panel.locator(".group.handoff-zone .task.has-detail .task-body").first().click();
  const detailHiddenAgain = await panel.evaluate(() => {
    return document.querySelector(".group.handoff-zone .task .task-detail")?.hidden ?? null;
  });
  check("③ 再点收起", detailHiddenAgain === true);

  // ④ CLI 带 --to 的交接单（assignee=Claude）直接进组、不进专区。
  await panel.evaluate(() => window.bookmark.add({ text: "指定收件人的交接单", kind: "handoff", assignee: "Claude" }));
  await panel.evaluate(() => bmRefresh());
  await waitFor(async () => {
    return panel.evaluate(() => document.querySelectorAll('#board .group[data-group="Claude"] .task.handoff').length === 1);
  });
  const zoneStillOne = await panel.evaluate(() => document.querySelectorAll(".group.handoff-zone .task").length);
  check("④ 指定收件人的交接单直接进组、专区数量不变", zoneStillOne === 1, `专区条数=${zoneStillOne}`);

  // ⑤ 拖拽派活：专区里未派发的交接单拖到 Claude 组头松手 = 派给 Claude（复用现有改派拖拽）。
  const recordsBeforeDrag = await panel.evaluate(() => window.bookmark.list());
  const handoffId = recordsBeforeDrag.find((r) => r.text.includes("分页改完"))?.id ?? "";
  await panel.locator(".group.handoff-zone .task.handoff").first().evaluate((el) => {
    el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
  });
  await panel.locator('#board .group[data-group="Claude"] .group-head').evaluate((el, id) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/bm-id", id);
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
  }, handoffId);
  const claudeHandoffs = await waitFor(async () => {
    return panel.evaluate(() => document.querySelectorAll('#board .group[data-group="Claude"] .task.handoff').length);
  });
  const zoneAfterDrag = await panel.evaluate(() => document.querySelectorAll(".group.handoff-zone .task").length);
  const recordsAfterDrag = await panel.evaluate(() => window.bookmark.list());
  const dragged = recordsAfterDrag.find((r) => r.text.includes("分页改完"));
  check("⑤ 交接单拖到 Claude 组头后组内现形（含指定收件人共 2 条）", claudeHandoffs === 2,
    `Claude组交接单=${claudeHandoffs}`);
  check("⑤ 拖拽后专区清空、assignee=Claude（数据层改派）", zoneAfterDrag === 0 && dragged?.assignee === "Claude",
    `专区条数=${zoneAfterDrag} assignee=${dragged?.assignee}`);

  // ⑥ 收回：组内交接单（拖过去的这条，按标题定位）点手柄 → 菜单「收回交接单专区」→ 回到专区（assignee 清空）。
  const claudeDraggedTask = panel.locator('#board .group[data-group="Claude"] .task.handoff', { hasText: "分页改完" });
  await claudeDraggedTask.locator(".handle").click();
  const backItem = panel.locator("#ctx-menu .ctx-item.back", { hasText: "收回交接单专区" });
  await backItem.waitFor({ state: "visible", timeout: 4000 });
  await backItem.click();
  const backInZone = await waitFor(async () => {
    return panel.evaluate(() => document.querySelectorAll(".group.handoff-zone .task").length === 1);
  });
  const recordsAfterBack = await panel.evaluate(() => window.bookmark.list());
  const backed = recordsAfterBack.find((r) => r.text.includes("分页改完"));
  check("⑥ 「收回交接单专区」后条目回专区（assignee 清空）", backInZone && backed?.assignee === null,
    `assignee=${backed?.assignee}`);

  // ⑦ remove 自删：接手 AI 接完活自己删（走 CLI 服务同款 IPC 管道），板上和库里都消失。
  const removed = backed ? await panel.evaluate((id) => window.bookmark.remove(id), backed.id) : false;
  await panel.evaluate(() => bmRefresh());
  await waitFor(async () => {
    return panel.evaluate(() => document.querySelectorAll(".group.handoff-zone .task").length === 0);
  }, 4000);
  const listAfterRemove = await panel.evaluate(() => window.bookmark.list());
  check("⑦ remove 后条目消失（剩普通条目+指定收件人交接单）", removed === true && listAfterRemove.length === 2,
    JSON.stringify(listAfterRemove.map((r) => r.text)));
  const emptyHint = await panel.evaluate(() => document.querySelector(".group.handoff-zone .empty")?.textContent ?? "");
  check("⑦ 专区空态提示在", emptyHint.includes("交接单"), emptyHint);
} catch (error) {
  failures.push(`脚本异常：${error?.message ?? error}`);
  console.error("脚本异常：", error);
} finally {
  try { await electronApp?.close(); } catch { /* 关不掉就算了 */ }
  try { rmSync(hubHome, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
}

if (failures.length) {
  console.error(`\n结果：${failures.length} 项没过 → ${failures.join("；")}`);
  process.exit(1);
}
console.log("\n结果：全部验证点通过");
