// 隔离看板回归（设定21，2026-10-12）：Ctrl 点选 → 右键「捆成一捆」、以最后一次为准、捆的毛玻璃样子、
// 设置浮层里的 AI 整理（选模型、自己加模型、没钥匙时的提示）、AI 捆的小机器人。
// 官方 Playwright 后台驱动；隔离数据夹，不连真模型、不碰用户看板数据。截图在 .runtime/organize/。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'bm-organize-ui-'));
const out = join(root, '.runtime/organize');
mkdirSync(out, { recursive: true });
let app;
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'dist/app.js')], env: { ...process.env, AGENT_PET_HUB_HOME: home } });
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
    for (const t of ['F 库面板返回键没反应', 'E 库面板首页卡片太空', 'D Markdown 脑图新建打不开', 'C Markdown 脑图右键新建不显示', 'B 看板加搜索', 'A 酒馆出图偏色']) out.unshift((await window.bookmark.add({ text: t, assignee: 'Claude' })).id);
    await bmRefresh();
    return out; // A B C D E F 从上到下
  });
  await page.locator('#tab-groups').click();
  assert.equal(await page.locator('#dispatch-toolbar').count(), 0, '顶上的派工工具栏撤掉了');

  // ① Ctrl 点 A B C，右键选中的那条 → 捆成一捆
  for (const id of ids.slice(0, 3)) await page.locator(`.task[data-id="${id}"] .num`).click({ modifiers: ['Control'] });
  assert.equal(await page.locator('.dispatch-selected').count(), 3);
  await page.locator(`.task[data-id="${ids[1]}"] .task-text`).click({ button: 'right' });
  assert.match(await page.locator('#ctx-menu').innerText(), /已选 3 条[\s\S]*捆成一捆/);
  await page.locator('#ctx-menu .ctx-input').fill('第一捆');
  await page.locator('#ctx-menu .ctx-input').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.bundle-head').length === 1);
  assert.equal(await page.locator('.bundle-head .bundle-name').innerText(), '第一捆');
  assert.equal(await page.locator('.dispatch-selected').count(), 0, '捆完清掉选择');

  // ② 没选中时右键还是原来那条的菜单
  await page.locator(`.task[data-id="${ids[4]}"] .task-text`).click({ button: 'right' });
  assert.doesNotMatch(await page.locator('#ctx-menu').innerText(), /捆成一捆/);
  await page.keyboard.press('Escape');
  await page.evaluate(() => bmHideCtxMenu());

  // ③ 以最后一次为准：C 已在第一捆，再选 C D E 捆 → C 出来进新捆，第一捆剩 A B
  for (const id of ids.slice(2, 5)) await page.locator(`.task[data-id="${id}"] .num`).click({ modifiers: ['Control'] });
  assert.equal(await page.locator('.dispatch-selected').count(), 3, '捆里的条目也能选');
  await page.locator(`.task[data-id="${ids[3]}"] .task-text`).click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: '捆成一捆' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.bundle-head').length === 2);
  const rows = await page.evaluate(() => window.bookmark.list());
  const bundleOf = id => rows.find(r => r.id === id).bundleId;
  assert.equal(bundleOf(ids[0]), bundleOf(ids[1]));
  assert.notEqual(bundleOf(ids[2]), bundleOf(ids[0]));
  assert.equal(bundleOf(ids[2]), bundleOf(ids[3]));
  assert.equal(bundleOf(ids[4]), bundleOf(ids[3]));
  assert.equal(bundleOf(ids[5]), null);
  const names = await page.locator('.bundle-head .bundle-name').allInnerTexts();
  assert.ok(names.includes('第一捆'));
  assert.ok(names.some(n => n.startsWith('C Markdown')), '不填捆名用第一条开头');

  // ④ 再捆一次让第一捆只剩一条 → 第一捆自己散掉
  for (const id of [ids[1], ids[5]]) await page.locator(`.task[data-id="${id}"] .num`).click({ modifiers: ['Control'] });
  await page.locator(`.task[data-id="${ids[5]}"] .task-text`).click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: '捆成一捆' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.bundle-head').length === 2);
  const rows2 = await page.evaluate(() => window.bookmark.list());
  assert.equal(rows2.find(r => r.id === ids[0]).bundleId, null, 'A 一个人成不了捆');

  // ⑤ AI 捆的有小机器人（直接走库里 AI 的口子，不连真模型）
  await page.evaluate(async () => {
    const a = await window.bookmark.add({ text: 'G 交接单一', kind: 'handoff' });
    const b = await window.bookmark.add({ text: 'H 交接单二', kind: 'handoff' });
    await window.bookmark.bundleSelected([a.id, b.id], '交接单这捆');
    await bmRefresh();
  });
  assert.equal(await page.locator('.handoff-zone .bundle-head').count(), 1, '交接单专区也能捆');
  assert.equal(await page.locator('.bundle-ai').count(), 0, '手动捆的没有小机器人');

  // ⑥ 设置浮层贴着右上角齿轮弹；AI 整理只占一行，点「设置…」弹窗口，保存才生效、取消丢掉
  await page.locator('#settings-btn').click();
  const gear = await page.locator('#settings-btn').boundingBox();
  const popBox = await page.locator('#settings-popover').boundingBox();
  assert.ok(popBox.y >= gear.y + gear.height && popBox.y < gear.y + gear.height + 20, '浮层就在齿轮下面');
  assert.ok(Math.abs((popBox.x + popBox.width) - (gear.x + gear.width)) < 16, '浮层右边对齐齿轮');
  await page.waitForFunction(() => document.querySelector('#org-brief')?.textContent === '没填钥匙');
  assert.equal(await page.locator('#settings-popover select, #settings-popover textarea').count(), 0, '一级只放一行，不摊开');
  await page.screenshot({ path: join(out, '设置浮层.png') });
  await page.locator('#org-open').click();
  await page.waitForSelector('#org-dialog');
  assert.equal(await page.locator('#settings-popover').isHidden(), true);
  const opts = await page.locator('#org-dlg-model option').allInnerTexts();
  assert.deepEqual(opts.slice(0, 2), ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']);
  assert.equal(await page.locator('#org-dlg-effort').inputValue(), 'high');
  assert.equal(await page.locator('#org-dlg-hours').inputValue(), '2');
  assert.match(await page.locator('#org-dlg-rules').inputValue(), /项目名/);
  assert.match(await page.locator('#org-dlg-status').innerText(), /还没填模型钥匙/);
  await page.screenshot({ path: join(out, '设置窗口.png') });
  // 改了点取消：什么都没存
  await page.locator('#org-dlg-hours').fill('5');
  assert.equal(await page.locator('#org-dlg-run').isDisabled(), true, '有改动没保存不让整理');
  await page.locator('#org-dlg-cancel').click();
  assert.equal(await page.locator('#org-dialog').count(), 0);
  assert.equal((await page.evaluate(() => window.bookmark.organizerGet())).intervalHours, 2);
  // 改了点保存：加模型、换档位、改间隔、改规矩都存上
  await page.evaluate(() => bmOpenOrganizerDialog());
  await page.waitForSelector('#org-dialog');
  await page.locator('#org-dlg-add').click();
  await page.locator('#org-dlg-add-name').fill('my/test-model');
  await page.locator('#org-dlg-add-name').press('Enter');
  await page.locator('#org-dlg-effort').selectOption('max');
  await page.locator('#org-dlg-hours').fill('3');
  await page.locator('#org-dlg-rules').fill('测试用规矩');
  await page.locator('#org-dlg-save').click();
  await page.waitForFunction(() => !document.querySelector('#org-dialog'));
  const saved = await page.evaluate(() => window.bookmark.organizerGet());
  assert.equal(saved.model, 'my/test-model');
  assert.equal(saved.effort, 'max');
  assert.equal(saved.intervalHours, 3);
  assert.equal(saved.rules, '测试用规矩');
  // 恢复默认 + 保存＝回到默认规矩
  await page.evaluate(() => bmOpenOrganizerDialog());
  await page.waitForSelector('#org-dialog');
  await page.locator('#org-dlg-default').click();
  await page.locator('#org-dlg-save').click();
  await page.waitForFunction(() => !document.querySelector('#org-dialog'));
  assert.equal((await page.evaluate(() => window.bookmark.organizerGet())).rulesIsDefault, true);
  // Esc 关窗口
  await page.evaluate(() => bmOpenOrganizerDialog());
  await page.waitForSelector('#org-dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#org-dialog').count(), 0);

  // ⑦ 拖进捆中间：缝撑在捆里面，不把捆撕开（缝在条目里是内边距，不是外边距）
  await page.evaluate(() => bmRefresh());
  const inner = await page.evaluate(() => {
    const members = [...document.querySelectorAll('.task.in-bundle')];
    const mid = members.find(el => !el.classList.contains('bundle-last') && el.previousElementSibling?.classList.contains('in-bundle'));
    mid.classList.add('gap-above');
    const cs = getComputedStyle(mid);
    const r = { marginTop: cs.marginTop, paddingTop: cs.paddingTop };
    mid.classList.remove('gap-above');
    return r;
  });
  assert.equal(inner.marginTop, '0px', '捆里的缝不用外边距');
  assert.equal(inner.paddingTop, '30px', '捆里的缝是捆自己撑开的');

  await page.setViewportSize({ width: 520, height: 900 });
  await page.screenshot({ path: join(out, '捆的样子.png') });
  assert.deepEqual(errors, []);
  console.log('ORGANIZE_UI_OK right-click-bundle last-wins lone-dissolve handoff-bundle popover-under-gear dialog-save-cancel gap-inside-bundle');
} finally {
  if (app) await app.close();
}
