// 交接单收尾 界面验证（Playwright·零抢鼠标）（2026-11-03）：
//   ① 挂起的交接单收在专区最底下、默认不显示，底下一颗「挂起的 N 张」钮，点了摊开、再点收起
//   ② 号码跟命令行一个数法：挂起的排在没挂起的后面
//   ③ 9 天没人碰的交接单整条淡下去、挂 🕸️ 小标
//   ④ 领着的窗口 3 小时没碰：♻️ 发灰、提示「可能掉线」
//   ⑤ 右键「挂起（先不做，等我说）」→ 收进底下；Ctrl+Z 退回来；右键「取消挂起」回到正常
// 用法：编好以后 BM_VERIFY_DIST=<编好的夹> node scripts/verify-bookmark-hold.mjs（不写就用 dist）
// 注意：独立 AGENT_PET_HUB_HOME 起实例，先写好一份假看板数据，不碰真看板。

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const dist = resolve(process.env.BM_VERIFY_DIST || join(root, "dist"));
const home = mkdtempSync(join(tmpdir(), "bm-hold-"));
const env = { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const card = (id, text, extra = {}) => ({
  id, text, url: null, assignee: null, dedupeKey: null, detail: null, kind: "handoff", batchId: null, forSystem: null,
  attachments: [], bundleId: null, claimedBy: null, claimedAt: null, report: null, reportedBy: null, reportedAt: null,
  createdAt: ago(60_000), sortedAt: null, userPinned: false, ...extra,
});
mkdirSync(join(home, "bookmark"), { recursive: true });
writeFileSync(join(home, "bookmark", "bookmarks.json"), JSON.stringify([
  card("h-held", "挂着的单子", { hold: { at: ago(HOUR), by: "用户", why: "他说先不做" } }),
  card("h-old", "九天没人碰的单子", { createdAt: ago(9 * 24 * HOUR) }),
  card("h-busy", "掉线窗口领着的单子", { createdAt: ago(4 * HOUR), claimedBy: "Claude-d981", claimedAt: ago(3 * HOUR) }),
  card("h-new", "刚写的单子"),
]), "utf8");

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

const app = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(dist, "app.js")], env });
try {
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().includes("bookmark/renderer"));
    if (!page) await sleep(100);
  }
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  await page.setViewportSize({ width: 620, height: 900 });
  const zone = page.locator("#board .handoff-zone");
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#board .handoff-zone .task")].map((li) => ({
    id: li.dataset.id, shown: li.offsetParent !== null, cls: li.className, num: li.querySelector(".num-col")?.textContent?.trim() ?? "",
    badges: [...li.querySelectorAll(".status-badge")].map((b) => `${b.className}|${b.dataset.label ?? ""}`),
  })));
  await waitFor(async () => (await rows()).length === 4);

  // ① ②
  let r = await rows();
  check("② 挂起的排在专区最后", r.at(-1)?.id === "h-held", r.map((x) => x.id).join());
  check("① 挂起的默认不显示", r.find((x) => x.id === "h-held")?.shown === false);
  const toggle = zone.locator(".held-toggle");
  check("① 底下有「挂起的 1 张」钮", (await toggle.count()) === 1 && /挂起的 1 张/.test(await toggle.textContent()));
  await toggle.click();
  await waitFor(async () => (await rows()).find((x) => x.id === "h-held")?.shown);
  r = await rows();
  check("① 点了摊开，挂 ⏸️ 小标带原因", r.find((x) => x.id === "h-held")?.shown === true && r.find((x) => x.id === "h-held").badges.some((b) => /status-hold.*他说先不做/.test(b)));
  await zone.locator(".held-toggle").click();
  await waitFor(async () => (await rows()).find((x) => x.id === "h-held")?.shown === false);
  check("① 再点收起", (await rows()).find((x) => x.id === "h-held")?.shown === false);

  // ③ ④
  r = await rows();
  const old = r.find((x) => x.id === "h-old");
  check("③ 九天没人碰的淡下去、挂 🕸️", /\bidle\b/.test(old?.cls ?? "") && old.badges.some((b) => /status-idle.*9 天没人碰/.test(b)), JSON.stringify(old?.badges));
  const busy = r.find((x) => x.id === "h-busy");
  check("④ 掉线窗口的 ♻️ 发灰、提示可能掉线", busy?.badges.some((b) => /claim-stale.*可能掉线/.test(b)), JSON.stringify(busy?.badges));
  const fresh = r.find((x) => x.id === "h-new");
  check("③ 刚写的不标", fresh?.badges.length === 0 && !/\bidle\b/.test(fresh.cls));

  // ⑤ 右键挂起 → 收进去；Ctrl+Z 退回；再右键取消挂起
  await zone.locator('.task[data-id="h-new"]').click({ button: "right" });
  await page.locator("#ctx-menu .ctx-item", { hasText: "挂起（先不做" }).click();
  await waitFor(async () => (await rows()).find((x) => x.id === "h-new")?.shown === false);
  r = await rows();
  check("⑤ 右键挂起：收进底下（排到最后两张里）", r.find((x) => x.id === "h-new")?.shown === false && r.slice(-2).some((x) => x.id === "h-new"), r.map((x) => x.id).join());
  await page.locator("#board").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await rows()).find((x) => x.id === "h-new")?.shown === true);
  check("⑤ Ctrl+Z 退回来", (await rows()).find((x) => x.id === "h-new")?.shown === true);
  await zone.locator(".held-toggle").click();
  await waitFor(async () => (await rows()).find((x) => x.id === "h-held")?.shown);
  await zone.locator('.task[data-id="h-held"]').click({ button: "right" });
  await page.locator("#ctx-menu .ctx-item", { hasText: "取消挂起" }).click();
  await waitFor(async () => !(await rows()).find((x) => x.id === "h-held")?.badges.some((b) => /status-hold/.test(b)));
  check("⑤ 右键取消挂起：回到正常、钮没了", (await zone.locator(".held-toggle").count()) === 0);
} finally {
  await app.close();
}
console.log(failed ? `\n✘ ${failed} 项没过` : "\n✔ 全过");
process.exit(failed ? 1 : 0);
