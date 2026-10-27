// 桌宠「藏起来 / 显示」记长久回归验证（2026-10-27 用户：选了藏就一直藏，放开就一直放开，开机关机不重置）：
//   ① 第一次开：幼苗出来
//   ② 点「藏起来」：藏了，preferences.json 记 hidden；重开还是藏着
//   ③ 点「显示桌宠」：出来了，记 hidden=false；重开照样出来；幼苗位置没被冲掉
// 用法：npm run build 之后 node scripts/verify-pet-hidden.mjs
// 注意：独立 AGENT_PET_HUB_HOME 起实例，不碰真桌宠；托盘菜单跟右键菜单走的都是 window:hide / window:show 这一份。

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "pet-hidden-"));
const env = { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home };
const prefsFile = join(home, "data", "preferences.json");
const prefs = () => (existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, "utf8")) : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
/** 幼苗窗口现在看不看得见（找不到窗口算 null）。 */
const petVisible = (app) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("pet/renderer"));
  return w ? w.isVisible() : null;
});
async function openApp() {
  const app = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(root, "dist/app.js")], env });
  await waitFor(async () => (await petVisible(app)) !== null, 15000);
  await sleep(2500); // 等 ready-to-show 那一下过去
  return app;
}
const send = (app, channel) => app.evaluate(({ ipcMain }, ch) => { ipcMain.emit(ch, {}); }, channel);

let app;
try {
  app = await openApp();
  check("① 第一次开：幼苗出来", (await petVisible(app)) === true);
  const pos = prefs();

  await send(app, "window:hide");
  check("② 点「藏起来」：藏了、记下 hidden", Boolean(await waitFor(async () => (await petVisible(app)) === false)) && prefs().hidden === true, JSON.stringify(prefs()));
  await app.close();
  app = await openApp();
  check("② 重开：还是藏着", (await petVisible(app)) === false, JSON.stringify(prefs()));

  await send(app, "window:show");
  check("③ 点「显示桌宠」：出来了、记下 hidden=false", Boolean(await waitFor(async () => (await petVisible(app)) === true)) && prefs().hidden === false, JSON.stringify(prefs()));
  await app.close();
  app = await openApp();
  check("③ 重开：照样出来，幼苗位置没被冲掉", (await petVisible(app)) === true && (pos.x === undefined || (prefs().x === pos.x && prefs().y === pos.y)), JSON.stringify(prefs()));
  console.log(failed ? `结果：${failed} 项没过` : "结果：全部验证点通过");
} finally {
  if (app) await app.close();
}
process.exit(failed ? 1 : 0);
