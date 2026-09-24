// 书签看板「启动 Agent 开窗贴字」真机验证（2026-09-24 用户拍板做法2，设定15第三版）：
//   ① 点「启动 Agent · 普通」→ 真开出一个新命令窗口（假快捷方式指向假 AI 程序 bookmark-fake-agent.ps1）
//   ② 新窗口收到的字＝启动句一字不差
//   ③ 没有按回车
//   ④ 看板提示「已贴进 Claude-1 窗口…你看一眼再按回车」
// 用法：npm run build 之后 node scripts/verify-bookmark-launch-paste.mjs
// 🚨 真机真窗口：会弹一个命令窗口、按一次 Ctrl+V，跑的那十几秒别碰键盘鼠标（抢了最前面，看板按规矩就不贴，这关会红）。
// 会动系统剪贴板，脚本开头存、结尾还原。期望答案都在本脚本里独立写，不调被测函数。

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const projectRoot = resolve(import.meta.dirname, "..");
const electronExe = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const appEntry = join(projectRoot, "dist", "app.js");
const cliScript = join(projectRoot, "scripts", "bookmark-cli.mjs");
const fakeAgent = join(projectRoot, "scripts", "bookmark-fake-agent.ps1");

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? `（${detail}）` : ""}`);
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

const hubHome = mkdtempSync(join(tmpdir(), "bm-launch-verify-"));
const shortcutDir = join(hubHome, "假桌面");
const outFile = join(hubHome, "假AI收到的.json");
mkdirSync(shortcutDir, { recursive: true });

// 假桌面上放一个「Claude Code 一」，指向假 AI 程序（跟真快捷方式一样是 powershell 开命令窗口）
const lnk = join(shortcutDir, "Claude Code 一.lnk");
const made = spawnSync("powershell.exe", [
  "-NoProfile", "-Command",
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BM_LNK); $s.TargetPath='powershell.exe';"
    + " $s.Arguments='-NoProfile -ExecutionPolicy Bypass -File \"' + $env:BM_FAKE + '\" \"' + $env:BM_OUT + '\"'; $s.Save()",
], { env: { ...process.env, BM_LNK: lnk, BM_FAKE: fakeAgent, BM_OUT: outFile }, encoding: "utf8" });
if (!existsSync(lnk)) throw new Error(`假快捷方式没建成：${made.stderr}`);

let electronApp;
let savedClipboard = null;
try {
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome, BOOKMARK_AGENT_SHORTCUT_DIR: shortcutDir },
  });
  savedClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const panel = await waitFor(async () => {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) return win;
    }
    return null;
  });
  if (!panel) throw new Error("书签面板窗口没出现");
  await panel.waitForLoadState("domcontentloaded");

  const id = await panel.evaluate(async () => {
    const r = await window.bookmark.add({ text: "开窗贴字：试一条" });
    await window.bookmark.setAssignee(r.id, "Claude");
    return r.id;
  });
  await panel.evaluate(() => bmRefresh());
  await panel.locator("#tab-groups").click();
  const row = panel.locator(`#board .task[data-id="${id}"]`);
  await row.waitFor({ state: "visible", timeout: 5000 });

  // 真用户是点了看板再点菜单，看板在最前面；这里先把测试看板提到最前面，再点菜单
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("bookmark/renderer"));
    win?.show();
    win?.focus();
  });
  await row.locator(".handle").click();
  const menu = panel.locator("#ctx-menu");
  await menu.waitFor({ state: "visible", timeout: 3000 });
  await menu.locator(".ctx-item", { hasText: "启动 Agent · 普通" }).click();

  const got = await waitFor(async () => (existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null), 45_000, 300);
  const expectLine = `领看板的活：node "${cliScript.split("\\").join("/")}" next ${id} --by Claude-1`;
  check("① 真开出了新命令窗口（假 AI 程序跑起来并交了结果）", Boolean(got), got ? "" : "45 秒没等到结果文件");
  check("② 新窗口收到的字＝启动句一字不差", got?.text === expectLine, `收到=${JSON.stringify(got?.text)}`);
  check("③ 没有按回车", got?.enter === false, `enter=${got?.enter}`);
  const toast = await waitFor(async () => {
    const text = (await panel.locator("#bm-toast").textContent()) ?? "";
    return text.includes("已贴进") ? text : null;
  }, 5000, 100);
  check("④ 看板提示已贴进 Claude-1 窗口、让用户自己按回车", (toast ?? "").includes("Claude-1") && (toast ?? "").includes("回车"),
    `提示=${toast ?? (await panel.locator("#bm-toast").textContent())}`);
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
