// 隔离看板回归（2026-10-13）：跨组一步到位拖动；Ctrl+X → Ctrl+V 拿着走、按住左键拖、松开放下、右键不要；
// 整捆搬家（按住捆标题拖、捆标题上 Ctrl+X）；Ctrl+C 不剪条目（2026-10-29 起只复制单独文件路径）；Ctrl+Z 撤回；单击详情就改；
// 所有组、所有时候第一行都是标题（还没读的拿自己的字顶着）；Ctrl 点选好几条一起剪、一起放（2026-10-27）。官方 Playwright 后台驱动，截图在 .runtime/carry/。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'bm-carry-'));
const out = join(root, '.runtime/carry');
mkdirSync(out, { recursive: true });
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `（${detail}）` : ''}`);
  if (!ok) failed += 1;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'dist/app.js')], env: { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: home } });
  let page;
  const end = Date.now() + 15000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().includes('bookmark/renderer'));
    if (!page) await wait(100);
  }
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  await page.setViewportSize({ width: 520, height: 1100 });
  const ids = await page.evaluate(async () => {
    const o = {};
    for (const t of ['D', 'C', 'B', 'A']) o[t] = (await window.bookmark.add({ text: `条目${t}`, assignee: 'Claude' })).id;
    for (const t of ['F', 'E']) o[t] = (await window.bookmark.add({ text: `条目${t}`, assignee: 'Antigravity' })).id;
    o.H = (await window.bookmark.add({ text: '交接单甲', kind: 'handoff', detail: '交接单甲的详情' })).id;
    await window.bookmark.bundleSelected([o.B, o.C], '捆一');
    await bmRefresh();
    return o;
  });
  await page.locator('#tab-groups').click();
  await wait(300);
  const rec = (id) => page.evaluate(async (x) => (await window.bookmark.list()).find((r) => r.id === x) ?? null, id);
  const order = (who) => page.evaluate(async (w) => (await window.bookmark.list()).filter((r) => r.assignee === w).map((r) => r.text.replace('条目', '')), who);
  const box = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y, bottom: b.y + b.height, h: b.height }; };
  const task = (id) => `.task[data-id="${id}"]`;
  const marks = () => page.evaluate(() => ({
    green: document.querySelectorAll('.bundle-drop').length,
    target: document.querySelectorAll('.bundle-target').length,
    head: document.querySelectorAll('.group-head.drag-target').length,
    gap: document.querySelectorAll('.gap-above, .gap-below, .gap-below-in, .gap-below-out').length,
  }));
  async function drag(id, to, shot) {
    const from = await box(`${task(id)} .num`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 2, from.y + 10, { steps: 3 });
    const p = await to();
    await page.mouse.move(p.x, p.y, { steps: 10 });
    await wait(200);
    const m = await marks();
    if (shot) await page.screenshot({ path: join(out, shot) });
    await page.mouse.up();
    await wait(500);
    return m;
  }

  // ⓪ 统一样子：还没读的条目、交接单，第一行都是标题，原文收着，没有「详情」按钮
  check('⓪ 还没读的条目第一行是标题（拿自己的字顶着）、原文收着', (await page.locator(`${task(ids.A)} .task-title.raw-title`).isVisible()) && !(await page.locator(`${task(ids.A)} .task-text`).isVisible()));
  check('⓪ 交接单也一样，没有「详情」按钮', (await page.locator(`${task(ids.H)} .task-title`).isVisible()) && (await page.locator(`${task(ids.H)} .detail-fold`).count()) === 0 && !(await page.locator(`${task(ids.H)} .task-detail`).isVisible()));

  // ① 跨组一步到位：Antigravity 的 E 拖到 Claude 组里 A 和捆一中间（捆头上半截）→ 不绿 → 松手进 Claude、单独放在 A 后面
  let m = await drag(ids.E, async () => { const h = await box(`.bundle-head`); return { x: h.x, y: h.top + 2 }; }, '1-跨组拖到两块中间.png');
  check('① 跨组拖到 Claude 组两块中间：不绿、露缝', m.green === 0 && m.target === 0 && m.gap >= 1, JSON.stringify(m));
  let e = await rec(ids.E);
  let cl = await order('Claude');
  check('① 松手 E 进了 Claude 组、单独放在 A 后面', e.assignee === 'Claude' && e.bundleId === null && cl.indexOf('E') === cl.indexOf('A') + 1, JSON.stringify(cl));

  // ② 跨组拖进捆：Antigravity 的 F 拖到捆一 B 的下半截 → 整捆绿 → 松手进捆一、插在 B 后面
  m = await drag(ids.F, async () => { const b = await box(task(ids.B)); return { x: b.x, y: b.bottom - b.h * 0.4 }; }, '2-跨组拖进捆.png');
  check('② 跨组拖进别组的捆：整捆变绿', m.green >= 2, JSON.stringify(m));
  const f = await rec(ids.F);
  const bundle = (await rec(ids.B)).bundleId;
  cl = await order('Claude');
  check('② 松手 F 进了 Claude 组的捆一、插在 B 后面', f.assignee === 'Claude' && f.bundleId === bundle && cl.indexOf('F') === cl.indexOf('B') + 1, JSON.stringify(cl));

  // ③ 普通条目拖不进交接单专区；交接单拖到空的 Antigravity 组（组里没条目）→ 组名亮 → 松手改派过去
  m = await drag(ids.D, async () => { const z = await box(`.group.handoff-zone .task`); return { x: z.x, y: z.y }; });
  check('③ 普通条目拖到交接单专区：什么都不亮、松手不动', m.green === 0 && m.gap === 0 && m.head === 0 && (await rec(ids.D)).assignee === 'Claude', JSON.stringify(m));
  m = await drag(ids.H, async () => { const g = await box(`.group[data-group="Antigravity"]`); return { x: g.x, y: g.y }; });
  check('③ 交接单拖进空的 Antigravity 组：组名亮、松手派过去', m.head === 1 && (await rec(ids.H)).assignee === 'Antigravity', JSON.stringify(m));

  // ④ Ctrl+X → Ctrl+V 拿着走 → 按住左键拖进捆 → 松手放下
  let a = await box(task(ids.A));
  await page.mouse.move(a.x, a.y);
  await page.keyboard.press('Control+x');
  await wait(150);
  check('④ 鼠标停在 A 上按 Ctrl+X：A 变淡带虚线', await page.locator(`${task(ids.A)}.clip-cut`).count() === 1);
  await page.keyboard.press('Control+v');
  await wait(150);
  check('④ 按 Ctrl+V：A 粘到鼠标上（原位置腾空）', (await page.evaluate(() => document.body.classList.contains('carrying'))) && (await page.locator('.drag-ghost').count()) === 1);
  // 指到哪、哪就开缝，下面的条会挪；像人手一样边看边对准：挪过去、再量、再对准
  let c;
  for (let i = 0; i < 3; i += 1) {
    c = await box(task(ids.C));
    await page.mouse.move(c.x, c.y, { steps: 6 });
    await wait(200);
  }
  m = await marks();
  await page.screenshot({ path: join(out, '4-拿着走进捆.png') });
  check('④ 拿着走到捆里：整捆变绿', m.green >= 2, JSON.stringify(m));
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 2, { steps: 3 });
  await page.mouse.up();
  await wait(500);
  const aRec = await rec(ids.A);
  check('④ 按住左键拖、松开：A 放进了捆一', aRec.bundleId === bundle && !(await page.evaluate(() => document.body.classList.contains('carrying'))), JSON.stringify(await order('Claude')));
  check('④ 放下后没误进改字', (await page.locator('.task-edit').count()) === 0);

  // ⑤ 拿着走时点右键＝不要了：D 留在原地，也不弹右键菜单
  const before = await order('Claude');
  const d = await box(task(ids.D));
  await page.mouse.move(d.x, d.y);
  await page.keyboard.press('Control+x');
  await page.keyboard.press('Control+v');
  await page.mouse.move(d.x, d.y - 120, { steps: 6 });
  await page.mouse.click(d.x, d.y - 120, { button: 'right' });
  await wait(500);
  check('⑤ 右键不要了：D 留在原地、拿着的状态没了、没弹菜单', JSON.stringify(await order('Claude')) === JSON.stringify(before) && !(await page.evaluate(() => document.body.classList.contains('carrying'))) && !(await page.locator('#ctx-menu').isVisible()), JSON.stringify(await order('Claude')));

  // ⑥ 整捆搬家：捆头有捆号；按住捆标题拖到 Antigravity 组名 → 整捆过去、还是一捆
  check('⑥ 捆头标着捆号', (await page.locator('.bundle-head .bundle-no').first().textContent()) === '捆1');
  const members = async () => (await page.evaluate(async (bid) => (await window.bookmark.list()).filter((r) => r.bundleId === bid).map((r) => r.assignee), bundle));
  const size = (await members()).length;
  let hb = await box('.bundle-head .bundle-name');
  await page.mouse.move(hb.x, hb.y);
  await page.mouse.down();
  await page.mouse.move(hb.x + 2, hb.y + 10, { steps: 3 });
  // 指到哪、哪就开缝，下面的组会往下挪；像人手一样边看边对准：挪过去、再量、再对准
  for (let i = 0; i < 3; i += 1) {
    const ga = await box(`.group[data-group="Antigravity"] .group-head`);
    await page.mouse.move(ga.x, ga.y, { steps: 6 });
    await wait(200);
  }
  m = await marks();
  await page.screenshot({ path: join(out, '6-整捆拖到别的组.png') });
  await page.mouse.up();
  await wait(600);
  let mem = await members();
  check('⑥ 按住捆标题拖到 Antigravity 组名：组名亮、整捆过去、还是一捆', m.head === 1 && mem.length === size && mem.every((x) => x === 'Antigravity'), JSON.stringify({ m, mem }));

  // ⑥ 捆标题上 Ctrl+X → Ctrl+V → 拿到 Claude 组名上按一下：整捆搬回来
  hb = await box('.bundle-head .bundle-name');
  await page.mouse.move(hb.x, hb.y);
  await page.keyboard.press('Control+x');
  await wait(150);
  check('⑥ 捆标题上 Ctrl+X：捆头和整捆都带虚线', (await page.locator('.bundle-head.clip-cut').count()) === 1 && (await page.locator('.task.clip-cut').count()) === size);
  await page.keyboard.press('Control+v');
  const gc = await box(`.group[data-group="Claude"] .group-head`);
  await page.mouse.move(gc.x, gc.y, { steps: 8 });
  await page.mouse.down();
  await page.mouse.up();
  await wait(600);
  mem = await members();
  check('⑥ 整捆拿着走放到 Claude：整捆回来、还是一捆', mem.length === size && mem.every((x) => x === 'Claude'), JSON.stringify(mem));

  // ⑥ Ctrl+C 不剪条目（只复制路径，剪还是 Ctrl+X）
  const dd = await box(task(ids.D));
  await page.mouse.move(dd.x, dd.y);
  await page.keyboard.press('Control+c');
  check('⑥ 鼠标停在条目上按 Ctrl+C：不剪、不拿着走', (await page.evaluate(() => bmClip)) === null && (await page.locator('.task.clip-cut').count()) === 0);

  // ⑦ 按住某条（长按）再按 Ctrl+X：剪下的就是按着的那条，这次拖动作废
  const b = await box(`${task(ids.B)} .num`);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.keyboard.press('Control+x');
  await page.mouse.up();
  await wait(200);
  check('⑦ 按住 B 按 Ctrl+X：剪的是 B', await page.locator(`${task(ids.B)}.clip-cut`).count() === 1);
  await page.keyboard.press('Escape');

  // ⑧ 在输入框里 Ctrl+C 是普通复制，不剪条目
  check('⑦ 没拿着时按 Esc：剪下的那条也放弃了', await page.locator('.task.clip-cut').count() === 0);
  await page.locator('.group[data-group="Claude"] .insert-row textarea').first().click();
  await page.keyboard.type('随便写');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  check('⑧ 输入框里按 Ctrl+C：不碰条目', (await page.evaluate(() => bmClip)) === null && (await page.locator('.task.clip-cut').count()) === 0);
  // ⑨ Ctrl+Z 撤回（2026-10-13）：拖错了按 Ctrl+Z 回原样；在框里打字时 Ctrl+Z 不碰看板
  await page.keyboard.press('Escape');
  await page.locator('#titlebar .title').click();
  await wait(300);
  const beforeDrag = JSON.stringify(await order('Claude'));
  await drag(ids.D, async () => { const h = await box('.bundle-head'); return { x: h.x, y: h.top + 2 }; });
  const afterDrag = JSON.stringify(await order('Claude'));
  await page.keyboard.press('Control+z');
  await wait(600);
  check('⑨ 拖了一条再按 Ctrl+Z：回到原来的位置', afterDrag !== beforeDrag && JSON.stringify(await order('Claude')) === beforeDrag, `${beforeDrag} → ${afterDrag} → ${JSON.stringify(await order('Claude'))}`);

  // ⑩ 交接单展开后单击详情就能改（2026-10-13 用户：点了没光标、一按就成拖动）；改完 Ctrl+Z 也能退回
  // 2026-10-24 起点小标题就直接进详情（交接单的正文）
  await page.locator(`${task(ids.H)} .task-title`).click();
  await wait(400);
  const editing = await page.evaluate(() => document.activeElement?.classList.contains('task-detail-edit') ?? false);
  check('⑩ 单击小标题：直接进详情改字框、光标在里面', editing);
  await page.keyboard.press('End');
  await page.keyboard.type('加一句');
  await page.keyboard.press('Enter');
  await wait(600);
  check('⑩ 改完存上了', (await rec(ids.H)).detail === '交接单甲的详情加一句', (await rec(ids.H)).detail);
  await page.locator('#titlebar .title').click();
  await page.keyboard.press('Control+z');
  await wait(600);
  check('⑩ Ctrl+Z：详情退回原来的', (await rec(ids.H)).detail === '交接单甲的详情', (await rec(ids.H)).detail);
  await page.screenshot({ path: join(out, '10-改详情再撤回.png') });

  // ⑪ 批量剪切（2026-10-27 用户：Ctrl 点选好几条，Ctrl+X 一起剪、Ctrl+V 一起放，归类用）：跨组选两条 → 放到 Antigravity 组名上 → 都过去；Ctrl+Z 一步全回来
  await page.locator('#titlebar .title').click();
  ids.K = await page.evaluate(async () => { const r = await window.bookmark.add({ text: '条目K', assignee: 'Antigravity' }); await bmRefresh(); return r.id; });
  await wait(400);
  const claudeBefore = JSON.stringify(await order('Claude'));
  await page.locator(`${task(ids.D)} .task-title`).click({ modifiers: ['Control'] });
  await page.locator(`${task(ids.K)} .task-title`).click({ modifiers: ['Control'] });
  check('⑪ Ctrl 点 D（Claude 组）和 K（Antigravity 组）：跨组也能选上两条', (await page.locator('.task.dispatch-selected').count()) === 2);
  const dm = await box(task(ids.D));
  await page.mouse.move(dm.x, dm.y);
  await page.keyboard.press('Control+x');
  await wait(150);
  check('⑪ 按 Ctrl+X：选中的两条都变淡带虚线', (await page.locator('.task.clip-cut').count()) === 2 && (await page.locator(`${task(ids.D)}.clip-cut, ${task(ids.K)}.clip-cut`).count()) === 2);
  await page.keyboard.press('Control+v');
  await wait(150);
  check('⑪ 按 Ctrl+V：拿起来了，影子写着一共 2 条', (await page.locator('.drag-ghost .bundle-ghost-count').textContent()) === '一共 2 条');
  for (let i = 0; i < 3; i += 1) {
    const ga = await box(`.group[data-group="Antigravity"] .group-head`);
    await page.mouse.move(ga.x, ga.y, { steps: 6 });
    await wait(200);
  }
  await page.screenshot({ path: join(out, '11-两条一起拿着走.png') });
  {
    const ga = await box(`.group[data-group="Antigravity"] .group-head`);
    await page.mouse.move(ga.x, ga.y);
  }
  await page.mouse.down();
  await page.mouse.up();
  await wait(600);
  check('⑪ 放到 Antigravity 组名上：两条都进了 Antigravity、选中也清了', (await rec(ids.D)).assignee === 'Antigravity' && (await rec(ids.K)).assignee === 'Antigravity' && (await page.locator('.task.dispatch-selected').count()) === 0, JSON.stringify(await order('Antigravity')));
  await page.locator('#titlebar .title').click();
  await page.keyboard.press('Control+z');
  await wait(600);
  check('⑪ Ctrl+Z 一步：D 回到 Claude 原位置、K 还在 Antigravity', JSON.stringify(await order('Claude')) === claudeBefore && (await rec(ids.K)).assignee === 'Antigravity', JSON.stringify(await order('Claude')));

  // ⑫ 同组选两条一起剪、拿到捆里（整捆变绿）松手：两条都进捆，按原来上下顺序挨着
  await page.locator(`${task(ids.D)} .task-title`).click({ modifiers: ['Control'] });
  await page.locator(`${task(ids.E)} .task-title`).click({ modifiers: ['Control'] });
  await page.keyboard.press('Control+x');
  await page.keyboard.press('Control+v');
  for (let i = 0; i < 3; i += 1) {
    c = await box(task(ids.C));
    await page.mouse.move(c.x, c.y, { steps: 6 });
    await wait(200);
  }
  m = await marks();
  check('⑫ 两条拿到捆里：整捆变绿', m.green >= 2, JSON.stringify(m));
  await page.mouse.down();
  await page.mouse.up();
  await wait(600);
  const de = await page.evaluate(async (x) => (await window.bookmark.list()).filter((r) => r.id === x.D || r.id === x.E).map((r) => r.bundleId), { D: ids.D, E: ids.E });
  const cl2 = await order('Claude');
  check('⑫ 松手：D、E 都进了捆一，挨着放', de.length === 2 && de.every((x) => x === bundle) && Math.abs(cl2.indexOf('D') - cl2.indexOf('E')) === 1, JSON.stringify(cl2));

  // ⑬ 剪下了怎么取消（2026-10-27 用户：剪错了虚线一直挂着）：底下挂提示条；同一条再按 Ctrl+X＝取消；点提示条「取消」也行
  await page.locator('#titlebar .title').click();
  const am = await box(task(ids.A));
  await page.mouse.move(am.x, am.y);
  await page.keyboard.press('Control+x');
  await wait(150);
  check('⑬ 剪下 A：底下挂着提示条，写着怎么取消', (await page.locator('#bm-clip-bar').isVisible()) && ((await page.locator('#bm-clip-bar .bm-clip-text').textContent()) || '').includes('取消'));
  await page.keyboard.press('Control+x');
  await wait(150);
  check('⑬ 同一条再按一次 Ctrl+X：不剪了（虚线、提示条都没了）', (await page.evaluate(() => bmClip)) === null && (await page.locator('.task.clip-cut').count()) === 0 && !(await page.locator('#bm-clip-bar').isVisible()));
  await page.keyboard.press('Control+x');
  await wait(150);
  await page.locator('#bm-clip-bar .bm-clip-cancel').click();
  await wait(150);
  check('⑬ 点提示条上的「取消」：不剪了', (await page.evaluate(() => bmClip)) === null && (await page.locator('.task.clip-cut').count()) === 0 && !(await page.locator('#bm-clip-bar').isVisible()));

  // ⑭ 交给哪套系统（2026-10-27）：交接单带 forSystem → 标题前挂名牌、只写名字；右键「交给哪套」能改、能拿掉
  ids.S = await page.evaluate(async () => { const r = await window.bookmark.add({ text: '交接单乙', kind: 'handoff', detail: '乙的详情', forSystem: '燊一修' }); await bmRefresh(); return r.id; });
  await wait(400);
  const tag = page.locator(`${task(ids.S)} .for-system`);
  check('⑭ 交接单写了交给燊一修：标题前挂名牌，只写「燊一修」', (await tag.count()) === 1 && ((await tag.textContent()) || '').trim() === '燊一修' && (await page.locator(`${task(ids.S)}.has-for-system`).count()) === 1);
  await page.locator(task(ids.S)).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, '14-交给哪套系统的名牌.png') });
  await page.locator(task(ids.S)).click({ button: 'right' });
  await wait(200);
  await page.locator('#ctx-menu .ctx-item', { hasText: /^根$/ }).click();
  await wait(400);
  check('⑭ 右键「交给哪套 → 根」：改成根', (await rec(ids.S)).forSystem === '根' && ((await page.locator(`${task(ids.S)} .for-system`).textContent()) || '').trim() === '根');
  await page.locator(task(ids.S)).click({ button: 'right' });
  await wait(200);
  await page.locator('#ctx-menu .ctx-item', { hasText: '不标' }).click();
  await wait(400);
  check('⑭ 右键「不标」：名牌拿掉', (await rec(ids.S)).forSystem === null && (await page.locator(`${task(ids.S)} .for-system`).count()) === 0);

  // ⑮ 找一摊活（2026-10-27）：点「🔍 找」输「agent 看板」回车 → 带这几个字的条目（跨组）全选中，接着 Ctrl+X 能一起剪
  //    隔离环境没配小模型：只按字找，提示里说一声
  ids.P = await page.evaluate(async () => { const r = await window.bookmark.add({ text: 'Agent看板六个点换模型', assignee: 'Claude' }); return r.id; });
  ids.Q = await page.evaluate(async () => { const r = await window.bookmark.add({ text: '看板交接单：Agent 看板要加资料组', kind: 'handoff' }); await bmRefresh(); return r.id; });
  await wait(300);
  await page.locator('#search-btn').click();
  await page.locator('#search-input').fill('agent 看板');
  await page.keyboard.press('Enter');
  await wait(1500);
  const picked = await page.evaluate(() => [...bmSelectedTasks]);
  check('⑮ 找「agent 看板」：两条（一条 Claude 组、一条交接单）都选中了', picked.length === 2 && picked.includes(ids.P) && picked.includes(ids.Q), JSON.stringify(picked));
  check('⑮ 提示说找到几条、没连上小模型只按字找', ((await page.locator('#bm-toast').textContent()) || '').includes('找到 2 条'), await page.locator('#bm-toast').textContent());
  await page.screenshot({ path: join(out, '15-找一摊活.png') });
  await page.locator('#titlebar .title').click();
  await page.keyboard.press('Control+x');
  await wait(150);
  check('⑮ 找到的接着 Ctrl+X：两条一起剪下', (await page.locator('.task.clip-cut').count()) === 2);
  await page.keyboard.press('Escape');

  console.log(failed ? `结果：${failed} 项没过` : '结果：全部验证点通过');
} finally {
  if (app) await app.close();
}
process.exit(failed ? 1 : 0);
