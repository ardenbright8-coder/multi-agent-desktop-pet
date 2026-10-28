// 隔离看板回归：打勾清单（2026-10-28）。真敲命令行 next → 清单 → 勾，看板上显示能点的小方框；
// 在看板上点着勾，小项全勾完上一层自己勾上；全勾完单子自动收掉、管着的条目一起没；Ctrl+Z 拿回来。
// 官方 Playwright 后台驱动（窗口藏起来，不抢鼠标），截图在 .runtime/checklist/。
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'bm-checklist-'));
const out = join(root, '.runtime/checklist');
mkdirSync(out, { recursive: true });
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `（${detail}）` : ''}`);
  if (!ok) failed += 1;
}
const cli = (...args) => {
  try {
    return execFileSync(process.execPath, [join(root, 'scripts/bookmark-cli.mjs'), ...args], { env: { ...process.env, AGENT_PET_HUB_HOME: home }, encoding: 'utf8' });
  } catch (error) {
    return `退出码 ${error.status}：${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
};
let app;
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'dist/app.js')], env: { ...process.env, AGENT_PET_ISOLATED: '1', AGENT_PET_HUB_HOME: home } });
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find(w => w.url().includes('bookmark/renderer'));
    if (!page) await new Promise(r => setTimeout(r, 100));
  }
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  await page.setViewportSize({ width: 520, height: 800 });
  const portFile = join(home, 'bookmark', 'cli-port.json');
  for (let i = 0; i < 50 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));

  const recs = await page.evaluate(async () => {
    await window.bookmark.add({ text: '原来那条：菜单点了没反应', assignee: 'Claude' });
    await window.bookmark.add({ text: '口语单子：菜单那个事你看一下，然后顺便把说明也改一改', kind: 'handoff', detail: '他说的一大段原话' });
    return await window.bookmark.list();
  });
  const card = recs.find(r => r.kind === 'handoff');
  const note = recs.find(r => r.kind === 'note');
  // 让交接单管着原来那条（命令行 handoff --closes 的效果），全勾完要一起没
  cli('handoff', '接着干：菜单和说明', '--closes', '01', '--detail', '他说的一大段原话');
  const card2 = (await page.evaluate(() => window.bookmark.list())).find(r => r.kind === 'handoff' && r.id !== card.id);

  // ① 没清单的交接单：领活叫先整理
  const first = cli('next', card2.id, '--by', 'T-1');
  check('① 领没清单的交接单：先叫整理清单、给了「清单」命令', /【先整理清单】/.test(first) && /看板 清单 \S+ --file 清单\.md --by T-1/.test(first), first.slice(0, 80));
  const md = join(home, '清单.md');
  writeFileSync(md, '- [ ] 1 修菜单\n  - [ ] 1.1 找到点了没反应的原因\n  - [ ] 1.2 改好\n- [ ] 2 改说明\n- [ ] 3 收尾\n');
  const set = cli('清单', card2.id, '--file', md, '--by', 'T-1');
  check('① 「清单」命令交进去了', /清单交进去了：3 件事、共 5 项（0\/3）/.test(set), set.trim());
  const tick = cli('勾', card2.id, '1.1');
  check('① 「勾」回一句短话带进度', tick.trim() === '✔ 1.1（0/3）', tick.trim());
  const again = cli('next', card2.id, '--by', 'T-1');
  check('① 再领：只吐没勾的、不吐原话、不用 done', /【打勾清单 0\/3】还没勾的：/.test(again) && /1\.2 改好/.test(again) && !/1\.1 找到/.test(again) && !/他说的一大段原话/.test(again) && !/ done /.test(again));
  const files = join(home, 'bookmark', '条目（一条一份）');
  check('① 副本分两份：清单那份带方框、原话那份收着原话',
    /- \[x\] 1\.1 找到点了没反应的原因/.test(readFileSync(join(files, `${card2.id}.md`), 'utf8')) && /他说的一大段原话/.test(readFileSync(join(files, `${card2.id}（原话）.md`), 'utf8')));

  // ①b 换窗口（2026-10-28 全面审）：有清单的单子本身就是交接单——写新单被拦，log＋release，新窗口接手看到最后一句进度
  const before = (await page.evaluate(() => window.bookmark.list())).length;
  const wrong = cli('handoff', '接着干', '--by', 'T-1', '--detail', 'x');
  check('①b 领着有清单的单子再写交接单：被拦下、叫它 log 再 release、一张没多', /本身就是交接单/.test(wrong) && (await page.evaluate(() => window.bookmark.list())).length === before, wrong.trim().slice(0, 60));
  cli('log', card2.id, '--by', 'T-1', '--text', '停在 1.2，等他拖');
  cli('release', card2.id, '--by', 'T-1');
  const take = cli('next', card2.id, '--by', 'T-2');
  check('①b 新窗口接手：看到最后一句进度和没勾的，清单还在', /最后一句进度：.+T-1：停在 1\.2，等他拖/.test(take) && /【打勾清单 0\/3】/.test(take));
  // ①c 钩子记下「这个窗口 → 这张单」，状态栏照着排点；放回去以后收起（钩子和状态栏在 E 盘装备夹，没有就跳过）
  const gear = 'E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/Claude Code装备（键位·状态栏·外观·权限·两套共用）/02_状态栏（额度和上下文常驻显示）';
  if (existsSync(join(gear, 'statusline.js'))) {
    const sid = `verify-checklist-${Date.now()}`;
    execFileSync(process.execPath, [join(gear, '看板领活-记下这窗口的单子.cjs')], { input: JSON.stringify({ session_id: sid, tool_input: { command: `node bookmark-cli.mjs next ${card2.id} --by T-2` }, tool_response: { stdout: take } }) });
    const bar = () => execFileSync(process.execPath, [join(gear, 'statusline.js')], { input: JSON.stringify({ session_id: sid, model: { display_name: 'x' }, context_window: { used_percentage: 1 } }), env: { ...process.env, COLUMNS: '150' }, encoding: 'utf8' }).replace(/\x1b\[[0-9;]*m/g, '');
    const shown = bar();
    check('①c 状态栏：看板任务 0/3，一后面两个点（1.1 勾了）、二三各一个', /看板任务 0\/3 {4}一 ● ● {4}二 ● {4}三 ●/.test(shown), shown.split('\n')[1]);
    cli('release', card2.id, '--by', 'T-2');
    await new Promise((r) => setTimeout(r, 800)); // 看板存盘后约 0.3 秒才对齐单子文件
    check('①c 放回去以后状态栏收起', !/看板任务/.test(bar()));
    cli('next', card2.id, '--by', 'T-1');
  }

  // ② 看板上：小方框，点着勾
  await page.evaluate(() => bmRefresh());
  await page.locator('#tab-groups').click();
  const C = `.task[data-id="${card2.id}"]`;
  check('② 看板上清单露着：5 项、表头 0/3', (await page.locator(`${C} .checklist-item`).count()) === 5 && (await page.locator(`${C} .checklist-head`).textContent()) === '打勾清单 0/3');
  check('② AI 勾过的 1.1 是勾上的', await page.locator(`${C} .checklist-item.done`).count() === 1);
  await page.screenshot({ path: join(out, '清单露着.png') });
  await page.locator(`${C} .checklist-item`).nth(2).click(); // 1.2
  await page.waitForTimeout(400);
  check('② 点 1.2：小项全勾完，1 自己勾上，表头 1/3', (await page.locator(`${C} .checklist-head`).textContent()) === '打勾清单 1/3' && await page.locator(`${C} .checklist-item.done`).count() === 3);
  const who = await page.evaluate(async (id) => (await window.bookmark.list()).find(r => r.id === id).checklist.find(x => x.no === '1.2').by, card2.id);
  check('② 看板上点的记成「用户」勾的', who === '用户', who);
  await page.locator(`${C} .checklist-item`).nth(2).click();
  await page.waitForTimeout(400);
  check('② 再点 1.2 取消：1 跟着回到没完', (await page.locator(`${C} .checklist-head`).textContent()) === '打勾清单 0/3');
  await page.locator(`${C} .checklist-item`).nth(0).click(); // 勾 1 ＝ 小项一起勾
  await page.locator(`${C} .checklist-item`).nth(3).click(); // 2
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, '勾了两项.png') });
  await page.locator(`${C} .checklist-item`).nth(4).click(); // 3 → 全勾完
  await page.waitForTimeout(600);
  const left = await page.evaluate(() => window.bookmark.list());
  check('③ 全勾完：单子自动收掉、管着的原来那条一起没了', !left.some(r => r.id === card2.id) && !left.some(r => r.id === note.id), left.map(r => r.text.slice(0, 10)).join('、'));
  check('③ 看板上那张不在了', await page.locator(C).count() === 0);
  const log = join(home, 'bookmark', '做完记录（最近50条·看板自动写）.md');
  check('③ 做完记录写了一行', existsSync(log) && /「接着干：菜单和说明」3 项全勾完，用户 勾的最后一项，自动收掉（连管着的 1 条）/.test(readFileSync(log, 'utf8')));
  await page.screenshot({ path: join(out, '全勾完收掉.png') });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  check('③ Ctrl+Z：那张和原来那条都回来了', await page.locator(C).count() === 1 && (await page.evaluate(() => window.bookmark.list())).some(r => r.id === note.id));
} catch (error) {
  console.log('✖ 跑挂了：', error?.message ?? error);
  failed += 1;
} finally {
  await app?.close().catch(() => {});
}
console.log(failed ? `✖ ${failed} 项没过` : '✔ 全过');
process.exit(failed ? 1 : 0);
