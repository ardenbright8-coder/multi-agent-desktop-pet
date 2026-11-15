// 隔离看板派工回归：Ctrl两捆、技能可见、整捆不能抢、报告唤回等待命令。
// 官方 Playwright 后台驱动；不注册主机热键、不启动AI、不碰用户看板数据。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'bm-dispatch-ui-'));
const env = { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home };
const script = join(root, 'scripts/bookmark-cli.mjs');
function run(args, ok = true) {
  const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 12000 });
  if (ok) assert.equal(r.status, 0, r.stderr);
  else assert.notEqual(r.status, 0);
  return r.stdout;
}
let app;
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(resolve(root, process.env.BM_VERIFY_DIST || 'dist'), 'app.js')], env });
  await app.evaluate(({ clipboard }) => {
    // 只在隔离 Electron 进程中截获复制内容，测试不写用户的系统剪贴板。
    globalThis.__dispatchClipboard = '';
    clipboard.writeText = value => { globalThis.__dispatchClipboard = value; };
    clipboard.readText = () => globalThis.__dispatchClipboard;
  });
  const end = Date.now() + 15000;
  let page;
  while (!page && Date.now() < end) {
    page = app.windows().find(w => w.url().includes('bookmark/renderer'));
    if (!page) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(page, '隔离看板出现');
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ids = await page.evaluate(async () => {
    const out = [];
    for (const n of [6, 5, 4, 3, 2, 1]) out.unshift((await window.bookmark.add({ text: `原始任务${n}`, assignee: 'Pi Agent' })).id);
    await bmRefresh();
    return out;
  });
  await page.locator('#tab-groups').click();
  // 多人派工捆走命令行（2026-10-12 设定21：看板顶上的派工工具栏撤了，界面只留右键「捆成一捆」）。
  run(['dispatch', 'bundle', '--ids', ids.slice(0, 3).join(','), '--name', '第一捆', '--coordinator', '主窗']);
  await page.evaluate(() => bmRefresh());
  await page.waitForFunction(() => document.querySelectorAll('.bundle-head').length === 1);
  for (const id of ids.slice(0, 1)) await page.locator(`.task[data-id="${id}"] .num`).click({ modifiers: ['Control'] });
  assert.equal(await page.locator('.dispatch-selected').count(), 0, '多人派工捆里的不能选');
  for (const id of ids.slice(3)) await page.locator(`.task[data-id="${id}"] .num`).click({ modifiers: ['Control'] });
  assert.equal(await page.locator('.dispatch-selected').count(), 3);
  assert.equal(await page.locator('.task-edit').count(), 0, 'Ctrl多选不进入改字/拖动');
  await page.locator(`.task[data-id="${ids[4]}"] .task-title`).click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-input').fill('第二捆');
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: '捆成一捆' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.bundle-head').length === 2);
  run(['dispatch', 'bundle', '--ids', ids.slice(3).join(','), '--name', '第二捆', '--coordinator', '主窗']);
  await page.evaluate(() => bmRefresh());
  await page.waitForFunction(() => document.querySelectorAll('.bundle-head').length === 2);
  const bundles = JSON.parse(run(['dispatch', 'list', '--coordinator', '主窗'])).bundles;
  assert.equal(bundles.length, 2);
  const first = bundles.find(b => b.name === '第一捆');
  const second = bundles.find(b => b.name === '第二捆');
  const a = JSON.parse(run(['next', first.id, '--by', '甲', '--json']));
  assert.equal(a.item.text, '原始任务1');
  assert.equal(a.cooperation, true);
  run(['next', first.id, '--by', '乙'], false);
  run(['next', ids[1], '--by', '乙'], false);
  const b = JSON.parse(run(['dispatch', 'next', '--to', 'Pi Agent', '--by', '乙', '--coordinator', '主窗', '--json']));
  assert.equal(b.bundleId, second.id);
  await page.evaluate(() => bmRefresh());
  await page.locator(`.bundle-head[data-bundle="${first.id}"] .handle`).click();
  assert.match(await page.locator('#ctx-menu').innerText(), /占住整捆/);
  assert.doesNotMatch(await page.locator('#ctx-menu').innerText(), /启动 Agent/);
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: '复制原窗口' }).click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copied, /next b-/);
  assert.match(copied, /不要开子助手/);

  // 调度工具正在等报告，报告来了返回到该工具调用，不创建AI会话。
  const waiter = spawn(process.execPath, [script, 'dispatch', 'wait', '--coordinator', '主窗', '--seconds', '8'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', err = '';
  waiter.stdout.on('data', b => output += b);
  waiter.stderr.on('data', b => err += b);
  const settled = new Promise((resolve, reject) => {
    waiter.on('error', reject);
    waiter.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
  });
  await new Promise(r => setTimeout(r, 500));
  run(['report', a.item.id, '--by', '甲', '--text', '改了文件A；测试通过；待审核']);
  await settled;
  const notices = JSON.parse(output).notices;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].worker, '甲');
  assert.equal(JSON.parse(run(['dispatch', 'messages', '--coordinator', '别主窗'])).notices.length, 0);
  run(['dispatch', 'ack', notices[0].id, '--coordinator', '别主窗'], false);
  run(['dispatch', 'ack', notices[0].id, '--coordinator', '主窗']);
  assert.equal(JSON.parse(run(['dispatch', 'messages', '--coordinator', '主窗'])).notices.length, 0);
  const next = JSON.parse(run(['next', first.id, '--by', '甲', '--json']));
  assert.equal(next.item.text, '原始任务2');
  assert.equal(next.position, 2);
  assert.equal(next.total, 3);
  run(['next', first.id, '--by', '乙'], false);
  const all = await page.evaluate(() => window.bookmark.list());
  assert.equal(all.length, 6, '报告不删除原任务');
  assert.deepEqual(all.map(x => x.text).sort(), [1, 2, 3, 4, 5, 6].map(n => `原始任务${n}`));

  // 原普通睡觉档也不能再自动开窗口；普通条目保留，写报告流程仍可用。
  let sleepNudges = 0;
  await page.evaluate(async () => {
    window.__dispatchNudges = 0;
    window.bookmark.onSleepNudged(() => window.__dispatchNudges++);
    await window.bookmark.add({ text: '普通睡觉档任务', assignee: 'Claude' });
    await window.bookmark.setMode('sleep');
  });
  await new Promise(r => setTimeout(r, 500));
  sleepNudges = await page.evaluate(() => window.__dispatchNudges);
  assert.equal(sleepNudges, 0, '睡觉档不再后台开助手');
  await page.evaluate(() => window.bookmark.setMode('day'));

  await page.locator('#tab-skills').click();
  // 技能页一个技能一行（2026-11-14）：名字＋一句功能，单击展开正本，右键「详情」看上下两段
  const card = page.locator('.skill-item[data-name="看板派工"]');
  assert.equal(await card.locator('.skill-feature').textContent(), '一摊活分成几捆，工兵逐条领、交报告', '一行只摆一句功能');
  await card.locator('.skill-row').click();
  await page.waitForFunction(() => document.querySelector('.skill-content:not([hidden])')?.textContent.includes('用户自己开新窗口'));
  const cliSkill = JSON.parse(run(['dispatch', 'skill', '看板派工'])).skill;
  assert.equal(await card.locator('.skill-content').textContent(), cliSkill.text, '人和AI同一正本');
  await card.locator('.skill-row').click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-item', { hasText: '详情' }).click();
  const detail = await card.locator('.skill-detail').innerText();
  assert.ok(detail.startsWith('10-07 Pi 建') && detail.includes('跟派活单的区别') && (await card.locator('.skill-detail hr').count()) === 1, `详情上下两段：${detail}`);
  run(['dispatch', 'skill', '../../auth.json'], false);
  await page.locator('#tab-projects').click();
  assert.equal(await page.locator('#tab-projects').getAttribute('class').then(x => x.includes('active')), true);
  assert.deepEqual(errors, []);
  mkdirSync(join(root, '.runtime/dispatch'), { recursive: true });
  await page.locator('#tab-skills').click();
  await page.waitForSelector('.skill-item');
  await page.screenshot({ path: join(root, '.runtime/dispatch/技能页.png') });
  console.log('DISPATCH_UI_OK ctrl-two-bundles whole-bundle-lock report-wait-notify same-skill-source no-agent-launch original-records-preserved');
} finally {
  if (app) await app.close();
}
