// 隔离看板回归（2026-10-13）：小标题在第一行、原文收起点小标题展开；复制钮钉在右上角跟第一行齐平；
// 右键菜单在外面一按下（点到条目文字、右键别处）就收起。官方 Playwright 后台驱动，截图在 .runtime/titles/。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const org = require(join(root, 'dist/bookmark/organizer.js'));
const home = mkdtempSync(join(tmpdir(), 'bm-titles-'));
const out = join(root, '.runtime/titles');
mkdirSync(out, { recursive: true });
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `（${detail}）` : ''}`);
  if (!ok) failed += 1;
}
let app;
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'dist/app.js')], env: { ...process.env, AGENT_PET_HUB_HOME: home } });
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find(w => w.url().includes('bookmark/renderer'));
    if (!page) await new Promise(r => setTimeout(r, 100));
  }
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  await page.setViewportSize({ width: 520, height: 800 });
  const recs = await page.evaluate(async () => {
    await window.bookmark.add({ text: '没读过的一条，照旧露原文两行', assignee: 'Claude' });
    await window.bookmark.add({ text: '然后还有一个问题，就是说，现在的话我发现你看你这个，怎么说呢你这个右边那个房子的话，你看因为你左边你看你这个项目里边左再返回，那你直接点返回就完了嘛，那个向左的箭头点了没反应', assignee: 'Claude' });
    return await window.bookmark.list();
  });
  const titled = recs.find(r => r.text.startsWith('然后'));
  const plain = recs.find(r => r.text.startsWith('没读过'));
  const notes = { [titled.id]: { project: '库管理面板', title: '项目页左上角的返回箭头点了没反应，回不到上一层，要修好；另外点底部任务栏图标时，想让它先弹出一个新窗口，像苹果那样', summary: 'x', key: org.noteKey(titled) } };
  writeFileSync(join(home, 'bookmark', 'AI条目小结.json'), JSON.stringify(notes));
  await page.evaluate(() => bmRefresh());
  await page.locator('#tab-groups').click();
  const T = `.task[data-id="${titled.id}"]`;
  const P = `.task[data-id="${plain.id}"]`;
  const vis = (sel) => page.locator(sel).isVisible();

  check('① 有小标题的：第一行是小标题，原文收起', (await vis(`${T} .task-title`)) && !(await vis(`${T} .task-text`)));
  check('① 没小标题的：照旧露原文', await vis(`${P} .task-text`));
  const box = (sel) => page.locator(sel).first().boundingBox();
  const [copy, title] = [await box(`${T} .t-copy`), await box(`${T} .task-title`)];
  check('② 复制钮钉在右上角、跟小标题第一行齐平', Math.abs(copy.y - title.y) <= 6, `复制钮 y=${Math.round(copy.y)} 小标题 y=${Math.round(title.y)}`);
  await page.screenshot({ path: join(out, '小标题收起.png') });
  await page.locator(`${T} .task-title`).click();
  check('③ 点小标题：原文展开', await vis(`${T} .task-text`));
  check('③ 展开后复制钮还在原位', Math.abs((await box(`${T} .t-copy`)).y - (await box(`${T} .task-title`)).y) <= 6);
  await page.screenshot({ path: join(out, '点开原文.png') });
  await page.locator(`${T} .task-title`).click();
  check('③ 再点收起', !(await vis(`${T} .task-text`)));

  // ④ 右键菜单：点到别条文字（会进改字、截走 click）也要收起
  await page.locator(`${T} .handle`).click();
  check('④ 点六个点打开菜单', await vis('#ctx-menu'));
  await page.locator(`${P} .task-text`).click();
  check('④ 点到别条的文字：菜单收起', !(await vis('#ctx-menu')));
  await page.keyboard.press('Escape');
  await page.locator(`${T} .handle`).click();
  await page.locator('#tab-groups').click({ button: 'right' });
  check('④ 右键点别处：菜单收起', !(await vis('#ctx-menu')));
  await page.locator(`${T} .handle`).click();
  await page.mouse.click(260, 760);
  check('④ 左键点空白：菜单收起', !(await vis('#ctx-menu')));
  console.log(failed ? `结果：${failed} 项没过` : '结果：全部验证点通过');
} finally {
  if (app) await app.close();
}
process.exit(failed ? 1 : 0);
