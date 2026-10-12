// 隔离看板回归（设定21，2026-10-12）：Ctrl 点选 → 右键「捆成一捆」、以最后一次为准、捆的毛玻璃样子、
// 设置浮层里的 AI 整理（选模型、自己加模型、没钥匙时的提示）、AI 捆的小机器人。
// 官方 Playwright 后台驱动；隔离数据夹，不连真模型、不碰用户看板数据。截图在 .runtime/organize/。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // 第四版：看板上的小橙点（AI 检查的提示）、整理记录——直接写进隔离数据夹，不连真模型
  const dataDir = join(home, 'bookmark');
  writeFileSync(join(dataDir, 'AI整理提示.json'), JSON.stringify({ hints: [{ itemId: ids[0], placement: 'loose', text: '可能该在「第一捆」捆', why: '讲的也是这件事', at: new Date().toISOString() }], dismissed: [], checked: {} }));
  writeFileSync(join(dataDir, 'AI整理记录.json'), JSON.stringify([{ at: new Date().toISOString(), model: 'Command Code · 测试', rows: [
    { group: 'Claude', action: '开新捆', title: '开新捆「Markdown脑图：新建」2 条', why: '两条都在说脑图新建', itemIds: [ids[2], ids[3]] },
    { group: 'Claude', action: '提示', title: '「A 酒馆出图偏色」可能该在「第一捆」捆', why: '讲的也是这件事', itemIds: [ids[0]] },
    { group: 'Claude', action: '放进', title: '删掉的条目', why: '', itemIds: ['早删了的'] },
  ] }]));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.getElementById('settings-popover').hidden = true; return bmRefresh(); });
  assert.equal(await page.locator('.bm-hint-dot').count(), 1, '有提示的那条挂一个小橙点');
  const dotBox = await page.locator('.bm-hint-dot').boundingBox();
  assert.ok(dotBox.width <= 16 && dotBox.height <= 16, '小橙点不大');
  await page.locator('.bm-hint-dot').hover();
  await page.waitForSelector('#bm-bubble:not([hidden])');
  assert.match(await page.locator('#bm-bubble').innerText(), /可能该在「第一捆」捆[\s\S]*讲的也是这件事[\s\S]*知道了/);
  await page.screenshot({ path: join(out, '小橙点气泡.png') });
  await page.locator('#bm-bubble button', { hasText: '知道了' }).click();
  await page.waitForFunction(() => !document.querySelector('.bm-hint-dot'));
  const book = JSON.parse(readFileSync(join(dataDir, 'AI整理提示.json'), 'utf8'));
  assert.equal(book.dismissed.length, 1, '点了知道了记下来，不再提');
  // 捆头六个点跟条目的一样淡
  const [headColor, taskColor] = await page.evaluate(() => [getComputedStyle(document.querySelector('.bundle-head .handle')).color, getComputedStyle(document.querySelector('.task .handle')).color]);
  assert.equal(headColor, taskColor, '捆头的点跟条目的点一个颜色');
  // 加分组：点「＋组」在顶上页签栏变出小框，不占底下一整条
  await page.locator('#add-agent-btn').click();
  assert.equal(await page.locator('#page-tabs #add-agent-row').isVisible(), true, '加分组小框在顶上');
  await page.screenshot({ path: join(out, '加分组小框.png') });
  await page.locator('#new-agent-cancel').click();

  await page.locator('#settings-btn').click();
  await page.locator('#org-open').click();
  await page.waitForSelector('#org-dialog');
  assert.equal(await page.locator('#settings-popover').isHidden(), true);
  const opts = await page.locator('#org-dlg-model option').allInnerTexts();
  assert.deepEqual(opts.slice(0, 2), ['Command Code · deepseek/deepseek-v4.1-flash（没填钥匙）', 'Command Code · z-ai/glm-5.3-flash（没填钥匙）']);
  assert.equal(await page.locator('#org-dlg-effort').inputValue(), 'high');
  assert.equal(await page.locator('#org-dlg-hours').inputValue(), '2');
  assert.match(await page.locator('#org-dlg-status').innerText(), /还没填模型钥匙/);
  assert.equal(await page.locator('.org-pane .bm-info').count(), 3, '长说明收进三个 ⓘ');
  assert.doesNotMatch(await page.locator('.org-pane').innerText(), /桌宠打开半分钟后/, '长说明不摊在页面上');
  assert.deepEqual(await page.locator('.org-run-line button:visible').allInnerTexts(), ['整理一次', '全部重来'], '就两个钮');
  // 整理记录：一行一件事；删掉的条目那行不显示；碰到那行冒理由
  assert.equal(await page.locator('.org-rec-row').count(), 2, '条目删了，那行记录也没了');
  await page.locator('.org-rec-row').first().hover();
  await page.waitForFunction(() => /为什么：两条都在说脑图新建/.test(document.querySelector('#bm-bubble:not([hidden])')?.innerText ?? ''));
  await page.screenshot({ path: join(out, '设置窗口.png') });
  await page.locator('.org-pane .bm-info').first().hover();
  await page.waitForFunction(() => /桌宠打开半分钟后/.test(document.querySelector('#bm-bubble:not([hidden])')?.innerText ?? ''));
  // 规矩页：左边按类排，整理 / 检查规矩能改，程序卡死的、题目、领活规矩只读，最底下是账本
  await page.locator('.bm-dialog-tab[data-tab="rules"]').click();
  const ruleNames = await page.locator('.rules-item').allInnerTexts();
  for (const want of ['整理规矩', '检查规矩', '程序卡死的规矩', 'AI 每次收到的题目', '日常档', '睡觉档', '多人派工（占住整捆）', '看板派工', '交接单', 'AI 整理账本']) assert.ok(ruleNames.includes(want), `规矩页有「${want}」`);
  assert.match(await page.locator('#org-rule-text').inputValue(), /项目名/);
  assert.equal(await page.locator('#org-rule-text').evaluate(el => el.readOnly), false, '整理规矩能改');
  await page.locator('.rules-item', { hasText: /^检查规矩$/ }).click();
  assert.match(await page.locator('#org-rule-text').inputValue(), /放错/);
  assert.equal(await page.locator('#org-rule-text').evaluate(el => el.readOnly), false, '检查规矩能改');
  await page.locator('.rules-item', { hasText: /^程序卡死的规矩$/ }).click();
  assert.match(await page.locator('#org-rule-text').inputValue(), /3 分钟/);
  assert.equal(await page.locator('#org-rule-text').evaluate(el => el.readOnly), true);
  await page.locator('.rules-item', { hasText: /^AI 每次收到的题目$/ }).click();
  assert.match(await page.locator('#org-rule-text').inputValue(), /整理题[\s\S]*分组：Claude[\s\S]*检查题/);
  await page.locator('.rules-item', { hasText: /^日常档$/ }).click();
  assert.match(await page.locator('#org-rule-text').inputValue(), /用户亲口说「可以」以后/);
  assert.equal(await page.locator('#org-rule-text').evaluate(el => el.readOnly), true, '领活规矩只读');
  await page.screenshot({ path: join(out, '规矩页.png') });
  await page.locator('.rules-item', { hasText: 'AI 整理账本' }).click();
  assert.match(await page.locator('#org-ledger').innerText(), /Claude[\s\S]*你动过/);
  await page.screenshot({ path: join(out, '账本.png') });
  // 改了点取消：什么都没存
  await page.locator('.bm-dialog-tab[data-tab="settings"]').click();
  await page.locator('#org-dlg-hours').fill('5');
  assert.equal(await page.locator('#org-dlg-run').isDisabled(), true, '有改动没保存不让整理');
  await page.locator('#org-dlg-cancel').click();
  assert.equal(await page.locator('#org-dialog').count(), 0);
  assert.equal((await page.evaluate(() => window.bookmark.organizerGet())).intervalHours, 2);
  // 加模型：填名字、地址、钥匙、模型名，马上存好并换成它；钥匙不回给界面
  await page.evaluate(() => bmOpenOrganizerDialog());
  await page.waitForSelector('#org-dialog');
  await page.locator('#org-dlg-add').click();
  await page.locator('#org-mf-save').click();
  assert.match(await page.locator('#org-mf-msg').innerText(), /^名字填一下/, '没填全会说缺啥，不带英文前缀');
  await page.locator('#org-mf-provider').fill('别家测试');
  await page.locator('#org-mf-url').fill('https://example.invalid/v1/chat/completions');
  await page.locator('#org-mf-key').fill('sk-测试钥匙');
  await page.locator('#org-mf-model').fill('my/test-model');
  await page.screenshot({ path: join(out, '加模型.png') });
  await page.locator('#org-mf-save').click();
  await page.waitForFunction(() => document.querySelector('#org-model-form').hidden);
  assert.equal(await page.locator('#org-dlg-model option:checked').innerText(), '别家测试 · my/test-model');
  const added = await page.evaluate(() => window.bookmark.organizerGet());
  const mine = added.models.find(m => m.model === 'my/test-model');
  assert.equal(mine.baseUrl, 'https://example.invalid/v1', '整段贴的地址也认');
  assert.equal(mine.hasKey, true);
  assert.equal(JSON.stringify(added).includes('sk-测试钥匙'), false, '钥匙不回给界面');
  assert.equal(added.current, mine.id);
  // 改它：钥匙留空＝不改
  await page.locator('#org-dlg-edit').click();
  assert.equal(await page.locator('#org-mf-key').inputValue(), '');
  await page.locator('#org-mf-provider').fill('别家改名');
  await page.locator('#org-mf-save').click();
  await page.waitForFunction(() => document.querySelector('#org-model-form').hidden);
  assert.equal((await page.evaluate(() => window.bookmark.organizerGet())).models.find(m => m.id === mine.id).hasKey, true, '没填钥匙＝原来的留着');
  // 换档位、改间隔、改两份规矩都存上
  await page.locator('#org-dlg-effort').selectOption('max');
  await page.locator('#org-dlg-hours').fill('3');
  await page.locator('.bm-dialog-tab[data-tab="rules"]').click();
  await page.locator('#org-rule-text').fill('测试用规矩');
  await page.locator('.rules-item', { hasText: /^检查规矩$/ }).click();
  await page.locator('#org-rule-text').fill('测试用检查规矩');
  await page.locator('#org-dlg-save').click();
  await page.waitForFunction(() => !document.querySelector('#org-dialog'));
  const saved = await page.evaluate(() => window.bookmark.organizerGet());
  assert.equal(saved.models.find(m => m.id === saved.current).label, '别家改名 · my/test-model');
  assert.equal(saved.effort, 'max');
  assert.equal(saved.intervalHours, 3);
  assert.equal(saved.rules, '测试用规矩');
  assert.equal(saved.checkRules, '测试用检查规矩');
  // 恢复默认 + 保存＝回到默认规矩（两份各点一次）
  await page.evaluate(() => bmOpenOrganizerDialog());
  await page.waitForSelector('#org-dialog');
  await page.locator('.bm-dialog-tab[data-tab="rules"]').click();
  await page.locator('#org-dlg-default').click();
  await page.locator('.rules-item', { hasText: /^检查规矩$/ }).click();
  await page.locator('#org-dlg-default').click();
  await page.locator('#org-dlg-save').click();
  await page.waitForFunction(() => !document.querySelector('#org-dialog'));
  const back = await page.evaluate(() => window.bookmark.organizerGet());
  assert.equal(back.rulesIsDefault, true);
  assert.equal(back.checkRulesIsDefault, true);
  // 删掉加的那个模型：点两下才删
  await page.evaluate(() => bmOpenOrganizerDialog());
  await page.waitForSelector('#org-dialog');
  await page.locator('#org-dlg-edit').click();
  await page.locator('#org-mf-remove').click();
  await page.locator('#org-mf-remove').click();
  await page.waitForFunction(() => document.querySelector('#org-model-form').hidden);
  assert.equal((await page.evaluate(() => window.bookmark.organizerGet())).models.some(m => m.model === 'my/test-model'), false);
  // 全部重来（没填钥匙：只拆、记一笔）→ 你捆的也拆 → 撤销重来回原样
  const bundlesBefore = await page.evaluate(async () => (await window.bookmark.list()).filter(r => r.bundleId).map(r => `${r.id}:${r.bundleId}`).sort());
  assert.ok(bundlesBefore.length >= 4);
  await page.locator('#org-dlg-reset').click();
  assert.equal(await page.locator('#org-dlg-reset').innerText(), '确定？再点一下');
  await page.locator('#org-dlg-reset').click();
  await page.waitForSelector('#org-dlg-undo:not([hidden])');
  assert.equal(await page.evaluate(async () => (await window.bookmark.list()).filter(r => r.bundleId).length), 0, '全部拆开，你捆的也拆');
  assert.match(await page.locator('#org-records').innerText(), /全部重来/);
  await page.screenshot({ path: join(out, '全部重来.png') });
  await page.locator('#org-dlg-undo').click();
  await page.waitForSelector('#org-dlg-undo[hidden]', { state: 'attached' });
  const bundlesAfter = await page.evaluate(async () => (await window.bookmark.list()).filter(r => r.bundleId).map(r => `${r.id}:${r.bundleId}`).sort());
  assert.deepEqual(bundlesAfter, bundlesBefore, '撤销重来回到原样');
  assert.match(await page.locator('#org-records').innerText(), /撤销重来/);
  // Esc：先收气泡，再关窗口
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#org-dialog').count(), 0);

  // ⑦ 拖进捆中间：缝撑在捆里面，不把捆撕开（缝在条目里是内边距，不是外边距）
  await page.evaluate(() => bmRefresh());
  const inner = await page.evaluate(() => {
    const members = [...document.querySelectorAll('.task.in-bundle')];
    const mid = members.find(el => !el.classList.contains('bundle-last') && el.previousElementSibling?.classList.contains('in-bundle'));
    mid.style.transition = 'none'; // 撑开有 0.12 秒动画，量的是终点
    mid.classList.add('gap-above');
    const cs = getComputedStyle(mid);
    const r = { marginTop: cs.marginTop, paddingTop: cs.paddingTop };
    mid.classList.remove('gap-above');
    return r;
  });
  assert.equal(inner.marginTop, '0px', '捆里的缝不用外边距');
  assert.equal(inner.paddingTop, '30px', '捆里的缝是捆自己撑开的');

  // ⑧ 带链接的长文：板上露的是字，链接只占一行（网站名＋路径，问号后面不要）
  const linkId = await page.evaluate(async () => {
    const nl = String.fromCharCode(10);
    const text = ['思考了 1m 17s', '', '...', '', '结论先说 你这套路线没错 https://huggingface.co/kohya-ss/x.safetensors?download=true&utm_source=chatgpt.com'].join(nl);
    const r = await window.bookmark.add({ text, assignee: 'Pi Agent', url: 'https://huggingface.co/kohya-ss/x.safetensors?download=true&utm_source=chatgpt.com' });
    await bmRefresh();
    return r.id;
  });
  assert.match(await page.locator(`.task[data-id="${linkId}"] .task-text`).innerText(), /思考了 1m 17s \.\.\. 结论先说/);
  assert.equal(await page.locator(`.task[data-id="${linkId}"] .task-url`).innerText(), '链接 · huggingface.co/kohya-ss/x.safetensors');

  await page.setViewportSize({ width: 520, height: 900 });
  await page.screenshot({ path: join(out, '捆的样子.png') });
  assert.deepEqual(errors, []);
  console.log('ORGANIZE_UI_OK right-click-bundle last-wins lone-dissolve handoff-bundle popover-under-gear dialog-save-cancel gap-inside-bundle');
} finally {
  if (app) await app.close();
}
