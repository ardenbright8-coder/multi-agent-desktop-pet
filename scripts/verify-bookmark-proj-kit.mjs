// 项目小按钮 + 接活自动标 回归验证（Playwright·零抢鼠标）（2026-10-29）：
//   ① 项目根那层每个夹带一排小按钮（默认设计思路、执行过程、资源包）＋末尾「＋」；子夹不带
//   ② 「＋」→ 新建 .md：原地起名、回车建好，按钮加在末尾，文件真的在
//   ③ 「＋」→ 挑已有的：夹里手放的 md 出现在菜单里，点了就加上
//   ④ 按住「执行过程」往左拖到「设计思路」前面：松手换了位置，重画后还是这个顺序；拖完不误开文件
//   ⑤ 右键「从这排拿掉」：按钮没了，文件还在
//   ⑥ 点号码复制单独文件路径 → 条目标成「已交出」（♻️ 小标）；命令行 next 这条 → 换成窗口名
// 用法：npm run build 之后 node scripts/verify-bookmark-proj-kit.mjs（BM_VERIFY_DIST 可指到别的编译夹，桌宠开着时不动 dist）
// 注意：独立 AGENT_PET_HUB_HOME 起实例，不碰真看板。

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const dist = resolve(process.env.BM_VERIFY_DIST || join(root, "dist"));
const cliScript = join(root, "scripts", "bookmark-cli.mjs");
const home = mkdtempSync(join(tmpdir(), "bm-projkit-"));
const env = { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home };
const projDir = join(home, "bookmark", "projects");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let restartAt = null; // ⑧ 重开看板那段用：哪条
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
function runCli(args) {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
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

  // 先建一个项目、手放一份 md
  await page.evaluate(() => window.bookmark.projectsMkdir("", "中医"));
  writeFileSync(join(projDir, "中医", "药方.md"), "# 药方\n", "utf8");
  await page.locator("#tab-projects").click();
  const chips = () => page.evaluate(() => [...document.querySelectorAll('#board .proj-kit[data-project="中医"] .proj-kit-btn:not(.proj-kit-plus)')].map((b) => b.dataset.name));
  await waitFor(async () => (await chips()).length === 3);

  // ①
  const plusCount = await page.locator('#board .proj-kit[data-project="中医"] .proj-kit-plus').count();
  check("① 项目行带默认三块＋末尾「＋」", (await chips()).join() === "设计思路.md,执行过程.md,资源包" && plusCount === 1, (await chips()).join());
  await page.locator("#board .proj-row", { hasText: "中医" }).locator(".proj-name").click();
  await waitFor(async () => (await page.locator("#board .proj-row").count()) >= 3);
  check("① 进到项目里面：子夹「资源包」不挂小按钮", (await page.locator("#board .proj-kit").count()) === 0);
  await page.locator(".proj-up").click();
  await waitFor(async () => (await chips()).length === 3);

  // ② 新建：点别处就建好；Ctrl+Z 撤回（没写东西的文件跟着删）
  const newMd = async (name, how) => {
    await page.locator('#board .proj-kit[data-project="中医"] .proj-kit-plus').click();
    await page.locator("#ctx-menu .ctx-item", { hasText: "新建 .md" }).click();
    const input = page.locator("#board .proj-kit-input");
    await input.fill(name);
    if (how === "enter") await input.press("Enter");
    else await page.locator("#board .proj-bar .proj-crumbs").click();
    await waitFor(async () => (await chips()).includes(`${name}.md`));
  };
  await newMd("草稿", "click");
  check("② 「＋」新建 .md：不按回车、点别处就建好", (await chips()).at(-1) === "草稿.md" && existsSync(join(projDir, "中医", "草稿.md")), (await chips()).join());
  await page.keyboard.press("Control+z");
  await waitFor(async () => !(await chips()).includes("草稿.md"));
  check("② Ctrl+Z 撤回新建：按钮没了、空文件删了", !(await chips()).includes("草稿.md") && !existsSync(join(projDir, "中医", "草稿.md")), (await chips()).join());
  await newMd("笔记", "enter");
  check("② 回车也照样建好，按钮加在末尾", (await chips()).at(-1) === "笔记.md" && existsSync(join(projDir, "中医", "笔记.md")), (await chips()).join());

  // ③
  await page.locator('#board .proj-kit[data-project="中医"] .proj-kit-plus').click();
  const pick = page.locator("#ctx-menu .ctx-item", { hasText: "加上「药方」" });
  check("③ 「＋」菜单里有夹里已有的「药方」", (await pick.count()) === 1);
  await pick.click();
  await waitFor(async () => (await chips()).includes("药方.md"));
  check("③ 点了就加上", (await chips()).join() === "设计思路.md,执行过程.md,资源包,笔记.md,药方.md", (await chips()).join());

  // ④ 按住执行过程往左拖到设计思路前面
  const kit = page.locator('#board .proj-kit[data-project="中医"]');
  const from = await kit.locator('.proj-kit-btn[data-name="执行过程.md"]').boundingBox();
  const to = await kit.locator('.proj-kit-btn[data-name="设计思路.md"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 6 });
  const gap = await page.locator("#board .kit-gap-before, #board .kit-gap-after").count();
  await page.mouse.up();
  await waitFor(async () => (await chips())[0] === "执行过程.md");
  const saved = JSON.parse(readFileSync(join(projDir, "中医", ".小按钮.json"), "utf8"));
  check("④ 拖动时缝亮竖线；松手执行过程排到第一个，账上也是", gap === 1 && (await chips())[0] === "执行过程.md" && saved[0] === "执行过程.md", `${(await chips()).join()} | ${saved.join()}`);
  await page.evaluate(() => bmRenderProjects());
  await waitFor(async () => (await chips()).length === 5);
  check("④ 重画后还是这个顺序", (await chips()).slice(0, 2).join() === "执行过程.md,设计思路.md");

  // ⑤
  await kit.locator('.proj-kit-btn[data-name="药方.md"]').click({ button: "right" });
  await page.locator("#ctx-menu .ctx-item", { hasText: "从这排拿掉" }).click();
  await waitFor(async () => !(await chips()).includes("药方.md"));
  check("⑤ 右键拿掉：按钮没了，文件还在", !(await chips()).includes("药方.md") && existsSync(join(projDir, "中医", "药方.md")));
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await chips()).includes("药方.md"));
  check("⑤ Ctrl+Z 一下：药方回来了", (await chips()).at(-1) === "药方.md", (await chips()).join());
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await chips())[0] === "设计思路.md");
  check("⑤ 再 Ctrl+Z 一下：拖的那步也退回去，设计思路回到第一个", (await chips()).slice(0, 2).join() === "设计思路.md,执行过程.md", (await chips()).join());

  // ⑥ 接活自动标
  const rec = await page.evaluate(() => window.bookmark.add({ text: "改一下搜索框", assignee: "Claude" }));
  await page.locator("#tab-groups").click();
  await page.evaluate((id) => window.bookmark.itemFile(id), rec.id);
  const claimed = () => page.evaluate(async (id) => (await window.bookmark.list()).find((r) => r.id === id)?.claimedBy ?? null, rec.id);
  await waitFor(async () => (await claimed()) === "已交出");
  await page.evaluate(() => bmRefresh());
  const badge = await waitFor(() => page.evaluate((id) => document.querySelector(`#board .task[data-id="${id}"] .status-badge.claim`)?.title ?? "", rec.id));
  check("⑥ 复制单独文件路径 → 标「已交出」、条目挂 ♻️ 小标", (await claimed()) === "已交出" && /已交给 AI/.test(badge), `${await claimed()} | ${badge}`);
  const got = runCli(["next", rec.id, "--by", "Claude-测试"]);
  check("⑥ 命令行 next 这条 → 换成窗口名", got.code === 0 && (await waitFor(async () => (await claimed()) === "Claude-测试")), got.out.split("\n")[0]);

  // ⑦ 别的交法一个逻辑：行尾复制也标；交两条按两下 Ctrl+Z 一条一条退；六个点启动直接标窗口名
  const who = (id) => page.evaluate(async (x) => (await window.bookmark.list()).find((r) => r.id === x)?.claimedBy ?? null, id);
  const b = await page.evaluate(() => window.bookmark.add({ text: "改按钮颜色", assignee: "Claude" }));
  const c = await page.evaluate(() => window.bookmark.add({ text: "改字号", assignee: "Claude" }));
  await page.evaluate(() => bmRefresh());
  await page.locator(`#board .task[data-id="${b.id}"] .t-copy`).click();
  await waitFor(async () => (await who(b.id)) === "已交出");
  await page.evaluate((id) => window.bookmark.itemFile(id), c.id);
  await waitFor(async () => (await who(c.id)) === "已交出");
  check("⑦ 行尾复制、点号码复制路径都标「已交出」", (await who(b.id)) === "已交出" && (await who(c.id)) === "已交出");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await who(c.id)) === null);
  check("⑦ Ctrl+Z 一下：只退最后交的那条", (await who(c.id)) === null && (await who(b.id)) === "已交出", `${await who(b.id)} / ${await who(c.id)}`);
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await who(b.id)) === null);
  check("⑦ 再 Ctrl+Z 一下：前一条也退了", (await who(b.id)) === null);
  const launched = await page.evaluate((id) => window.bookmark.launchLine(id, "Claude", false, null), c.id);
  await waitFor(async () => (await who(c.id)) === launched.label);
  check("⑦ 六个点启动 Agent：直接标成看板起的窗口名", (await who(c.id)) === launched.label, `${launched.label} / ${await who(c.id)}`);

  // ⑧ 撤销一定撤得掉：光标在每组第一格空框里按 Ctrl+Z 也退看板；点 ♻️ 放回去；重开看板 Ctrl+Z 照样退
  await page.evaluate((id) => window.bookmark.itemFile(id), b.id);
  await waitFor(async () => (await who(b.id)) === "已交出");
  await page.evaluate(() => bmRefresh());
  await page.locator('#board .group[data-group="Claude"] textarea').first().click();
  const inBox = await page.evaluate(() => document.activeElement?.tagName);
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await who(b.id)) === null);
  check("⑧ 光标停在空框里按 Ctrl+Z：照样退「交给 AI」", inBox === "TEXTAREA" && (await who(b.id)) === null, `${inBox} / ${await who(b.id)}`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate((id) => window.bookmark.itemFile(id), b.id);
  await waitFor(async () => (await who(b.id)) === "已交出");
  await page.evaluate(() => bmRefresh());
  await page.locator(`#board .task[data-id="${b.id}"] .claim-handed`).click();
  await waitFor(async () => (await who(b.id)) === null);
  check("⑧ 点一下 ♻️：放回去", (await who(b.id)) === null);
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await who(b.id)) === "已交出");
  check("⑧ 点错了 Ctrl+Z：又回到「已交出」", (await who(b.id)) === "已交出");
  restartAt = b.id;
} finally {
  await app.close();
}

// ⑧ 续：关掉看板重开（等于点「升级」），Ctrl+Z 照样退上一步「交给 AI」
if (restartAt) {
  const again = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(dist, "app.js")], env });
  try {
    let page;
    const end = Date.now() + 15000;
    while (!page && Date.now() < end) {
      page = again.windows().find((w) => w.url().includes("bookmark/renderer"));
      if (!page) await sleep(100);
    }
    await page.waitForLoadState("domcontentloaded");
    await again.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
    const who = (id) => page.evaluate(async (x) => (await window.bookmark.list()).find((r) => r.id === x)?.claimedBy ?? null, id);
    await waitFor(async () => (await page.locator("#board .task").count()) > 0);
    const before = await who(restartAt);
    await page.keyboard.press("Control+z");
    await waitFor(async () => (await who(restartAt)) === null);
    check("⑧ 重开看板以后 Ctrl+Z：照样退「交给 AI」", before === "已交出" && (await who(restartAt)) === null, `${before} → ${await who(restartAt)}`);
  } finally {
    await again.close();
  }
}
console.log(failed ? `结果：${failed} 项没过` : "结果：全部验证点通过");
process.exit(failed ? 1 : 0);
