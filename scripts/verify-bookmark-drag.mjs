// 书签看板「拖动 / 单击」回归验证（Playwright·零抢鼠标）：残影 ①～⑤，单击和拖动分开 ⑥～⑩。
// 病根（2026-09-24 用户报：拖完屏幕上留下 ⠿01、⠿03 这种窄残影拿不掉）：
//   按下去那一刻窗口拿到焦点 → 看板整张重画 → 手里按着的那条被换掉；
//   0.3 秒后长按到点，拿已换掉的旧条目做影子（宽 0），松手事件又只挂在旧条目上收不到 → 影子永远留着。
// 三个验证点：
//   ① 按住后马上重画（用户截图那种）→ 松手后页面上一个残影都没有
//   ② 拖到一半重画（手机来新消息那种）→ 松手后没残影，而且照样插进去了
//   ③ 拖动中来的新条目，松手后补画出来，不丢
// 用法：npm run build 之后 node scripts/verify-bookmark-drag.mjs
// 注意：用独立 AGENT_PET_HUB_HOME 起实例（空书签库、收信模块静默不启动），用完关闭并清理。

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

const hubHome = mkdtempSync(join(tmpdir(), "bm-drag-verify-"));
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

  const texts = ["条目甲", "条目乙", "条目丙"];
  for (const text of texts) await panel.evaluate((t) => window.bookmark.add({ text: t }), text);
  // 看板窗口拿到焦点就重画——跟真机点一下窗口是同一条路。
  const repaint = () => panel.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await repaint();
  await waitFor(async () => (await panel.locator("#board .task").count()) === 3);

  const order = () => panel.evaluate(() =>
    [...document.querySelectorAll("#board .task .task-text")].map((el) => el.textContent));
  const leftovers = () => panel.evaluate(() => ({
    ghosts: document.querySelectorAll(".drag-ghost").length,
    hidden: document.querySelectorAll(".is-dragging").length,
  }));
  /** 按在条目右侧空白处（避开手柄和正文，正文单击会进编辑）。 */
  async function pressPoint(index) {
    const box = await panel.locator("#board .task").nth(index).boundingBox();
    return { x: box.x + box.width - 30, y: box.y + box.height / 2 };
  }
  async function rowTop(index) {
    const box = await panel.locator("#board .task").nth(index).boundingBox();
    return { x: box.x + box.width - 30, y: box.y + 4 };
  }

  // ① 按住后马上重画：用户截图那种。
  {
    const p = await pressPoint(0);
    await panel.mouse.move(p.x, p.y);
    await panel.mouse.down();
    await repaint();
    await sleep(600); // 过了 0.32 秒长按门槛
    await panel.mouse.move(p.x + 5, p.y + 60, { steps: 6 });
    await panel.mouse.up();
    await sleep(300);
    const left = await leftovers();
    check("① 按住后马上重画，松手后页面上没残影", left.ghosts === 0 && left.hidden === 0,
      `残影=${left.ghosts} 被藏起的条目=${left.hidden}`);
  }
  await repaint();
  await sleep(300);

  // ②③ 拖到一半重画 + 拖动中来新条目：把第 3 条拖到最前。
  {
    const before = await order();
    const moving = before[2];
    const p = await pressPoint(2);
    const target = await rowTop(0);
    await panel.mouse.move(p.x, p.y);
    await panel.mouse.down();
    await sleep(500);
    await panel.mouse.move(p.x, (p.y + target.y) / 2, { steps: 5 });
    await panel.evaluate(() => window.bookmark.add({ text: "拖动中来的新条目" }));
    await repaint();
    await sleep(300);
    await panel.mouse.move(target.x, target.y, { steps: 5 });
    await panel.mouse.up();
    const after = await waitFor(async () => {
      const now = await order();
      return now.length === 4 ? now : null;
    }, 4000);
    const left = await leftovers();
    check("② 拖到一半重画，松手后没残影", left.ghosts === 0 && left.hidden === 0,
      `残影=${left.ghosts} 被藏起的条目=${left.hidden}`);
    check("② 拖到一半重画，照样插到最前", Array.isArray(after) && after.filter((t) => t !== "拖动中来的新条目")[0] === moving,
      `拖前=${before.join("/")} 拖后=${after ? after.join("/") : "没等到 4 条"}`);
    check("③ 拖动中来的新条目，松手后补画出来", Array.isArray(after) && after.includes("拖动中来的新条目"),
      `拖后=${after ? after.join("/") : "没等到 4 条"}`);
  }

  // ⑥～⑨ 单击和拖动分开（2026-09-24 用户拍板）：按下直接挪就是拖，不用等；没挪就松手是单击，松手马上改字。
  await repaint();
  await sleep(300);
  const editing = () => panel.locator("#board .task-edit").count();
  {
    const before = await order();
    const moving = before[before.length - 1];
    // 按在文字上拖——人最常下手的地方，也是最容易被当成「点一下改字」的地方。
    const textBox = await panel.locator("#board .task .task-text").nth(before.length - 1).boundingBox();
    const p = { x: textBox.x + Math.min(20, textBox.width / 2), y: textBox.y + textBox.height / 2 };
    const target = await rowTop(0);
    await panel.mouse.move(p.x, p.y);
    await panel.mouse.down();
    await panel.mouse.move(p.x, target.y, { steps: 8 }); // 不等，直接挪
    await panel.mouse.up();
    const after = await waitFor(async () => {
      const now = await order();
      return now[0] === moving ? now : null;
    }, 3000);
    check("⑥ 按下直接挪（不等）就能拖到最前", !!after, `拖前=${before.join("/")} 拖后=${(after || await order()).join("/")}`);
    check("⑨ 拖完松手不会误进改字", (await editing()) === 0, `改字框=${await editing()}`);
  }
  {
    await panel.locator("#board .task .task-text").first().click();
    const quick = await waitFor(async () => (await editing()) === 1, 500, 50);
    check("⑦ 单击文字，松手马上进改字（半秒内）", !!quick, `改字框=${await editing()}`);
    await panel.keyboard.press("Escape");
    await sleep(300);
    // 用户原话：鼠标在那不动，单击点了半天没反应——按住不挪、停一会儿再松手，也得算单击。
    const box = await panel.locator("#board .task .task-text").first().boundingBox();
    await panel.mouse.move(box.x + 10, box.y + box.height / 2);
    await panel.mouse.down();
    await sleep(800);
    await panel.mouse.up();
    const slow = await waitFor(async () => (await editing()) === 1, 500, 50);
    check("⑧ 按住不挪停一会儿再松手，也算单击进改字", !!slow, `改字框=${await editing()}`);
    await panel.keyboard.press("Escape");
    await sleep(300);
  }

  // ④⑤ Agent 分组页：组里的条目、组标题同一套长按拖动，同样过一遍。
  await panel.evaluate(() => window.bookmark.add({ text: "Claude 组条目一", assignee: "Claude" }));
  await panel.evaluate(() => window.bookmark.add({ text: "Claude 组条目二", assignee: "Claude" }));
  await panel.locator("#tab-groups").click();
  await waitFor(async () => (await panel.locator('#board .group[data-group="Claude"] .task').count()) === 2);

  {
    const box = await panel.locator('#board .group[data-group="Claude"] .task').first().boundingBox();
    const p = { x: box.x + box.width - 30, y: box.y + box.height / 2 };
    await panel.mouse.move(p.x, p.y);
    await panel.mouse.down();
    await repaint();
    await sleep(600);
    await panel.mouse.move(p.x + 5, p.y + 40, { steps: 6 });
    await panel.mouse.up();
    await sleep(300);
    const left = await leftovers();
    check("④ 分组页：按住组里条目后马上重画，松手后没残影", left.ghosts === 0 && left.hidden === 0,
      `残影=${left.ghosts} 被藏起的条目=${left.hidden}`);
  }
  await repaint();
  await sleep(300);

  {
    const groupOrder = () => panel.evaluate(() =>
      [...document.querySelectorAll("#board .group:not(.handoff-zone)")].map((el) => el.dataset.group));
    const before = await groupOrder();
    const moving = before[2];
    const headBox = await panel.locator(`#board .group[data-group="${moving}"] .group-head`).boundingBox();
    const topBox = await panel.locator(`#board .group[data-group="${before[0]}"]`).boundingBox();
    const p = { x: headBox.x + headBox.width * 0.4, y: headBox.y + headBox.height / 2 };
    await panel.mouse.move(p.x, p.y);
    await panel.mouse.down();
    await sleep(500);
    await panel.mouse.move(p.x, (p.y + topBox.y) / 2, { steps: 5 });
    await repaint();
    await sleep(300);
    await panel.mouse.move(p.x, topBox.y + 4, { steps: 5 });
    await panel.mouse.up();
    const after = await waitFor(async () => {
      const now = await groupOrder();
      return now[0] === moving ? now : null;
    }, 4000);
    const left = await leftovers();
    check("⑤ 分组页：拖组标题到一半重画，松手后没残影", left.ghosts === 0 && left.hidden === 0,
      `残影=${left.ghosts} 被藏起的组=${left.hidden}`);
    const final = after || await groupOrder();
    check("⑤ 分组页：拖组标题到一半重画，照样挪到最前", final[0] === moving,
      `拖前=${before.join("/")} 拖后=${final.join("/")}`);
  }

  // ⑩ 项目页：拖文件夹不会误点进去；单击马上进。
  await panel.evaluate(() => window.bookmark.projectsMkdir("", "单双击测试夹"));
  await panel.locator("#tab-projects").click();
  const folderRow = () => panel.locator('#board .proj-row[data-rel="单双击测试夹"]');
  await waitFor(async () => (await folderRow().count()) === 1);
  {
    const box = await folderRow().boundingBox();
    await panel.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
    await panel.mouse.down();
    await panel.mouse.move(box.x + box.width - 30, box.y + box.height / 2 + 30, { steps: 6 });
    await panel.mouse.up();
    await sleep(500);
    const stillTop = (await folderRow().count()) === 1;
    check("⑩ 项目页拖一下文件夹，松手不会误点进去", stillTop, `还在上一层=${stillTop}`);
    if (stillTop) await folderRow().click();
    const entered = await waitFor(async () => (await folderRow().count()) === 0, 1000, 50);
    check("⑩ 项目页单击文件夹马上进去", !!entered);
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
