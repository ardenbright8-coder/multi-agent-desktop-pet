// 看板「🔍 找」按意思找回归验证（2026-10-27）：拿真看板数据的复制品（临时夹，不碰真看板）跑，
//   ① 说法跟原文不一样（「说话说两句就没了」）：按意思找到语音那几条并选中  ② 不相干的话（「今天天气怎么样」）：按意思一条都不加
// 用法：npm run build 之后 node scripts/verify-bookmark-search-meaning.mjs（要本机接好 kb-search-board）
import { createRequire } from "node:module";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const root = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "bm-meaning-"));
// 只拷看板数据（条目、小结），不拷端口这些运行时文件
cpSync("F:\\应用数据\\AgentPetHub\\bookmark", join(home, "bookmark"), { recursive: true, filter: (src) => !/cli-port\.json$|attachments/.test(src) });
const env = { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failed += 1;
}

const app = await _electron.launch({ executablePath: join(root, "node_modules/electron/dist/electron.exe"), args: [join(root, "dist/app.js")], env });
try {
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().includes("bookmark/renderer"));
    if (!page) await sleep(100);
  }
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  await sleep(1500);
  const t0 = Date.now();
  const voice = await page.evaluate(() => window.bookmark.search("说话说两句就没了"));
  const ms = Date.now() - t0;
  // 08 号、01 号：语音输入说两句就断
  const want = ["mvf8sca7-12fb8040", "mvlx43fz-3a62e65d"];
  check("① 说法跟原文不一样：按意思找到语音那几条", want.every((id) => voice.ids.includes(id)) && voice.byMeaning > 0 && !voice.vectorError,
    `按意思 ${voice.byMeaning} 条，共 ${voice.ids.length} 条，${ms} 毫秒${voice.vectorError ? `，错：${voice.vectorError}` : ""}`);
  const weather = await page.evaluate(() => window.bookmark.search("今天天气怎么样"));
  check("② 不相干的话：按意思一条都不加", weather.byMeaning === 0 && !weather.vectorError, `按意思 ${weather.byMeaning} 条`);
  console.log(failed ? `结果：${failed} 项没过` : "结果：全部验证点通过");
} finally {
  await app.close();
}
process.exit(failed ? 1 : 0);
