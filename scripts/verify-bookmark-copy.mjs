// 书签看板「复制 / 交给 AI 干活」回归验证（Playwright·零抢鼠标）（2026-09-24 用户拍板，设定12、15）：
//   ① 行尾复制钮常显、平时淡，移到这一行变清楚
//   ② 点行尾复制 → 剪贴板就是这条的文字（给用户自己用，不弹气泡）
//   ③ 分组页六个点：「启动 Agent · 带编程 / 普通」「收回待定」「删除这条」，没有「派给」
//   ④ 待定页六个点：有「派给 →」，没有「启动 Agent」（待定是还在商量）
//   ⑤ 启动 Agent · 带编程 → 剪贴板是一句「领看板的活：node "…bookmark-cli.mjs" next <条> --by Claude-1 --coding」
//   ⑥ 组头 ＋ 细线图标；⑦ 组名前官方标志
//   ⑧ 捆一捆：拖一条压到另一条正中间 → 出捆头、两条都在框里
//   ⑨ 真命令领活：next 领到第一条、看板出「🔄 Claude-9 在干」、领活说明里有统一规矩；
//      done 不带用户原话不收；带了才删
//   ⑩ 放回去：六个点「放回去」→ 在干标记没了
// 用法：npm run build 之后 node scripts/verify-bookmark-copy.mjs
// 注意：用独立 AGENT_PET_HUB_HOME 起实例；会动系统剪贴板，脚本开头存、结尾还原。
// 期望答案都在本脚本里独立写，不调被测函数。

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const projectRoot = resolve(import.meta.dirname, "..");
const electronExe = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const appEntry = join(projectRoot, "dist", "app.js");
const cliScript = join(projectRoot, "scripts", "bookmark-cli.mjs");

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
writeFileSync(join(hubHome, "bookmark", "要求模板", "带编程.md"), TEMPLATE + "\n", "utf8");

/** 真跑一次看板命令（跟 AI 敲的一模一样），连的是这个测试实例。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [cliScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 现在跑着的 Claude Code 程序编号（claude.exe）。 */
function claudePids() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return [...(r.stdout ?? "").matchAll(/"claude\.exe","(\d+)"/gi)].map((m) => m[1]);
}

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

  // Claude 组从上到下：甲 乙 丙；待定一条
  const ids = await panel.evaluate(async () => {
    const out = {};
    for (const text of ["丙：参数设置看不见", "乙：快捷键设置看不见", "甲：脑图搜索框看不见"]) {
      const r = await window.bookmark.add({ text });
      await window.bookmark.setAssignee(r.id, "Claude");
      out[text[0]] = r.id;
    }
    await window.bookmark.add({ text: "待定里的一条" });
    return out;
  });
  await panel.evaluate(() => bmRefresh());
  await panel.locator("#tab-groups").click();
  const rows = panel.locator('#board .group[data-group="Claude"] .task');
  await rows.first().waitFor({ state: "visible", timeout: 5000 });
  const row = rows.first();
  const copyBtn = row.locator(".t-copy");
  const menu = panel.locator("#ctx-menu");
  const menuTexts = () => menu.locator(".ctx-item").allTextContents();
  const closeMenu = () => panel.locator("#titlebar .title").click();

  // ① 常显淡色
  const opacity = () => copyBtn.evaluate((el) => getComputedStyle(el).opacity);
  await panel.mouse.move(2, 2);
  const idle = Number(await opacity());
  await row.hover();
  const hover = await waitFor(async () => ((await opacity()) === "1" ? "1" : null), 2000, 50);
  check("① 行尾复制常显、平时淡，移上去变清楚", idle > 0 && idle < 1 && hover === "1", `平时=${idle} 移上去=${hover}`);

  // ② 行尾复制＝这条的文字
  await copyBtn.click();
  const copied = await waitFor(async () => ((await readClipboard()) === "甲：脑图搜索框看不见" ? "ok" : null), 3000, 50);
  const popShown = await panel.locator("#copy-pop").count();
  check("② 行尾复制直接复制这条、不弹气泡", copied === "ok" && popShown === 0, `剪贴板=${JSON.stringify(await readClipboard())}`);

  // ③ 分组页六个点
  await row.locator(".handle").click();
  await menu.waitFor({ state: "visible", timeout: 3000 });
  const groupMenu = await menuTexts();
  check("③ 分组页六个点：启动 Agent 两项 + 收回待定 + 删除，没有派给",
    groupMenu.includes("启动 Agent · 带编程") && groupMenu.includes("启动 Agent · 普通")
      && groupMenu.includes("收回待定") && groupMenu.includes("删除这条") && !groupMenu.some((t) => t.includes("派给") || t === "ChatGPT"),
    JSON.stringify(groupMenu));

  // ⑤ 启动 Agent · 带编程 → 启动句
  const claudeBefore = claudePids();
  await menu.locator(".ctx-item", { hasText: "启动 Agent · 带编程" }).click();
  const line = await waitFor(async () => {
    const text = await readClipboard();
    return text.startsWith("领看板的活：") ? text : null;
  }, 3000, 50);
  const expectLine = `领看板的活：node "${cliScript.split("\\").join("/")}" next ${ids.甲} --by Claude-1 --coding`;
  // 剪贴板先写、查完快捷方式才弹提示，等提示换成这次的再读（别读到开机那句「代码是最新的」）
  const toast = await waitFor(async () => {
    const text = (await panel.locator("#bm-toast").textContent()) ?? "";
    return text.includes("Claude-1") ? text : null;
  }, 3000, 50);
  check("⑤ 启动 Agent · 带编程：剪贴板是领活那一句（窗口名 Claude-1）", line === expectLine && (toast ?? "").includes("Claude-1"),
    `剪贴板=${JSON.stringify(line)} 提示=${toast}`);
  // 测试模式只报开哪个、不真开（app.ts 传 openAgents: !testMode），免得测一次弹一个真 Claude 窗口
  // 真开窗、真贴字另有 verify-bookmark-launch-paste.mjs（假快捷方式＋假 AI 程序）
  check("⑤b 启动 Agent 开的是桌面「Claude Code 一」快捷方式，提示看板会替他贴、回车他自己按",
    (toast ?? "").includes("Claude Code 一") && (toast ?? "").includes("贴进去") && (toast ?? "").includes("回车"), `提示=${toast}`);
  // 2026-09-24 踩过：测试实例把用户桌面上真的「Claude Code 一」打开了，跑一次多一个空 Claude 窗口
  await new Promise((r) => setTimeout(r, 4000));
  const strayClaude = claudePids().filter((pid) => !claudeBefore.includes(pid));
  check("⑤c 测试实例不许打开真的 Claude 窗口", strayClaude.length === 0, `新冒出的 Claude 程序=${strayClaude.join(",")}`);

  // ④ 待定页六个点
  await closeMenu();
  await panel.locator("#tab-inbox").click();
  const inboxRow = panel.locator("#board .task").first();
  await inboxRow.waitFor({ state: "visible", timeout: 3000 });
  await inboxRow.locator(".handle").click();
  await menu.waitFor({ state: "visible", timeout: 3000 });
  const inboxMenu = await menu.innerText();
  check("④ 待定页六个点：有派给、没有启动 Agent", inboxMenu.includes("派给") && inboxMenu.includes("Claude") && !inboxMenu.includes("启动 Agent"),
    JSON.stringify(inboxMenu));
  await closeMenu();
  await panel.locator("#tab-groups").click();

  // ⑥ 组头细线图标（2026-09-24 起 agent 组不放小加号，只剩交接单专区那个）
  const head = await panel.locator('#board .group.handoff-zone .group-head').evaluate((el) => {
    const add = el.querySelector(".g-add");
    return { svg: !!add?.querySelector("svg"), text: add?.textContent ?? "", size: add?.getBoundingClientRect().width ?? 99 };
  });
  check("⑥ 组头 ＋ 是细线图标、不大于 22 像素", head.svg && head.text.trim() === "" && head.size <= 22, JSON.stringify(head));

  // ⑦ 官方标志
  await panel.evaluate(() => window.bookmark.addAgent("我的新组"));
  await panel.evaluate(() => bmRefresh());
  await panel.locator('#board .group[data-group="我的新组"]').waitFor({ state: "visible", timeout: 3000 });
  const marks = await panel.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll("#board .group[data-group]")].map((g) => {
      const dot = g.querySelector(".group-head .dot");
      return [g.dataset.group, dot ? (dot.dataset.logo || "圆点") : "无"];
    }),
  ));
  check("⑦ 组名前：五家官方标志（含 Antigravity），自加的组是圆点",
    marks.Claude === "claude" && marks.ChatGPT === "openai" && marks["Pi Agent"] === "pi" && marks.Antigravity === "antigravity" && marks.Hermes === "hermes" && marks["我的新组"] === "圆点",
    JSON.stringify(marks));

  // ⑧ 捆一捆：按住「丙」拖到「甲」正中间
  const boxOf = async (i) => rows.nth(i).boundingBox();
  const a = await boxOf(0);
  const c = await boxOf(2);
  await panel.mouse.move(c.x + c.width - 40, c.y + c.height / 2);
  await panel.mouse.down();
  await panel.mouse.move(c.x + c.width - 40, (c.y + a.y) / 2 + 10, { steps: 5 });
  await panel.mouse.move(a.x + a.width - 40, a.y + a.height / 2, { steps: 6 });
  await panel.mouse.up();
  const bundled = await waitFor(async () => panel.evaluate(() => {
    const g = document.querySelector('#board .group[data-group="Claude"]');
    const heads = g.querySelectorAll(".bundle-head").length;
    const inside = [...g.querySelectorAll(".task.in-bundle .task-text")].map((el) => el.textContent);
    return heads === 1 && inside.length === 2 ? inside : null;
  }), 4000, 100);
  check("⑧ 拖到正中间就捆上：出捆头，甲和丙在框里挨着", JSON.stringify(bundled) === JSON.stringify(["甲：脑图搜索框看不见", "丙：参数设置看不见"]),
    JSON.stringify(bundled));

  // ⑨ 真命令领活
  const bundleId = await panel.evaluate(() => document.querySelector('#board .group[data-group="Claude"] .bundle-head')?.dataset.bundle ?? "");
  const got = runCli(["next", bundleId, "--by", "Claude-9", "--coding"]);
  const badge = await waitFor(async () => panel.evaluate(() => {
    const el = document.querySelector('#board .group[data-group="Claude"] .task .claim');
    return el ? el.textContent : null;
  }), 4000, 100);
  check("⑨ next：领到第 1/2 条，要求在前，说明里有统一规矩；看板出「🔄 Claude-9 在干」",
    got.code === 0 && got.out.includes("第 1/2 条") && got.out.includes("先读工作流") && got.out.includes("## 这次的事")
      && got.out.includes("甲：脑图搜索框看不见") && got.out.includes("一次只干这一条") && got.out.includes("--ok")
      && badge === "🔄 Claude-9 在干",
    `退出码=${got.code} 标记=${badge}\n${got.out.slice(0, 400)}`);
  const stolen = runCli(["next", bundleId, "--by", "Claude-10"]);
  check("⑨ 别的窗口来领，领到的是下一条（丙），不会抢走甲", stolen.code === 0 && stolen.out.includes("丙：参数设置看不见"), stolen.out.slice(0, 200));
  const noOk = runCli(["done", ids.甲, "--by", "Claude-9"]);
  check("⑨ done 不带用户原话：不收", noOk.code !== 0 && noOk.out.includes("--ok"), noOk.out.slice(0, 200));
  const done = runCli(["done", ids.甲, "--by", "Claude-9", "--ok", "可以，验过了"]);
  const gone = await waitFor(async () => panel.evaluate((id) => !document.querySelector(`#board .task[data-id="${id}"]`), ids.甲), 4000, 100);
  check("⑨ done 带了用户原话：看板上这条没了", done.code === 0 && gone === true, done.out.slice(0, 200));

  // ⑩ 放回去：丙被 Claude-10 领着 → 六个点「放回去」
  const cRow = panel.locator(`#board .task[data-id="${ids.丙}"]`);
  await cRow.locator(".handle").click();
  await menu.waitFor({ state: "visible", timeout: 3000 });
  const release = menu.locator(".ctx-item", { hasText: "放回去" });
  const hasRelease = (await release.count()) === 1;
  if (hasRelease) await release.click();
  const cleared = await waitFor(async () => panel.evaluate((id) => !document.querySelector(`#board .task[data-id="${id}"] .claim`), ids.丙), 3000, 100);
  check("⑩ 六个点「放回去」后在干标记没了", hasRelease && cleared === true, `有放回去=${hasRelease}`);
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
