// 隔离看板回归（2026-10-13 拖动改版）：变绿＝合并，不绿＝单独放。
// 拖进一捆的范围整捆变绿、松手插进这个位置；拖到两捆中间哪边都不绿、松手拆出来单独放；压在散着的一条正中间它变绿、松手捆一起。
// 官方 Playwright 后台驱动；隔离数据夹，不碰用户看板数据。截图在 .runtime/drag-bundle/。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'bm-drag-bundle-'));
const out = join(root, '.runtime/drag-bundle');
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
  await page.setViewportSize({ width: 520, height: 900 });
  const ids = await page.evaluate(async () => {
    const out = {};
    for (const t of ['F', 'E', 'D', 'G', 'C', 'B', 'A']) out[t] = (await window.bookmark.add({ text: `条目${t}`, assignee: 'Claude' })).id;
    await window.bookmark.bundleSelected([out.B, out.C, out.G], '捆一');
    await window.bookmark.bundleSelected([out.D, out.E], '捆二');
    await bmRefresh();
    return out;
  });
  await page.locator('#tab-groups').click();
  const rows = () => page.evaluate(async () => (await window.bookmark.list()).filter(r => r.assignee === 'Claude').map(r => `${r.text.replace('条目', '')}${r.bundleId ? '·' + r.bundleId.slice(-4) : ''}`));
  const bundleOf = (id) => page.evaluate(async (x) => (await window.bookmark.list()).find(r => r.id === x)?.bundleId ?? null, id);
  const center = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y, bottom: b.y + b.height, h: b.height }; };
  const task = (id) => `.task[data-id="${id}"]`;
  const headOf = async (id) => `.bundle-head[data-bundle="${await bundleOf(id)}"]`;
  const state = () => page.evaluate(() => ({
    green: [...new Set([...document.querySelectorAll('.bundle-drop')].map(e => e.dataset.bundle))],
    target: document.querySelectorAll('.bundle-target').length,
    gap: document.querySelectorAll('.gap-above, .gap-below, .gap-below-in, .gap-below-out').length,
  }));
  async function drag(id, to, shot) {
    const from = await center(`${task(id)} .num`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 2, from.y + 10, { steps: 3 });
    const p = await to();
    await page.mouse.move(p.x, p.y, { steps: 8 });
    await new Promise(r => setTimeout(r, 200));
    const s = await state();
    if (shot) await page.screenshot({ path: join(out, shot) });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 400));
    return s;
  }
  const one = await bundleOf(ids.B);
  const two = await bundleOf(ids.D);
  check('起手：A 散着、捆一 B C G、捆二 D E、F 散着', JSON.stringify(await rows()) === JSON.stringify(['A', `B·${one.slice(-4)}`, `C·${one.slice(-4)}`, `G·${one.slice(-4)}`, `D·${two.slice(-4)}`, `E·${two.slice(-4)}`, 'F']), JSON.stringify(await rows()));

  // ① 捆里调顺序：G 拖到 B 上半截 → 捆一整捆绿 → 松手 G 在 B 上面、还在捆一
  let s = await drag(ids.G, async () => { const b = await center(task(ids.B)); return { x: b.x, y: b.top + 4 }; }, '1-捆里调顺序.png');
  check('① 拖在自己这捆里：整捆变绿', s.green.length === 1 && s.green[0] === one, JSON.stringify(s));
  let r = await rows();
  check('① 松手在捆里调了顺序、还在捆一', r.indexOf(`G·${one.slice(-4)}`) === r.indexOf(`B·${one.slice(-4)}`) - 1, JSON.stringify(r));

  // ② 拖到两捆中间（捆二捆头的上半截）→ 哪边都不绿 → 松手 C 拆出来、单独夹在两捆中间
  s = await drag(ids.C, async () => { const h = await center(await headOf(ids.D)); return { x: h.x, y: h.top + 2 }; }, '2-两捆中间不绿.png');
  check('② 拖到两捆中间：哪边都不绿、只露缝', s.green.length === 0 && s.target === 0 && s.gap >= 1, JSON.stringify(s));
  r = await rows();
  check('② 松手 C 拆出来，单独放在两捆中间', (await bundleOf(ids.C)) === null && r.indexOf('C') > r.indexOf(`B·${one.slice(-4)}`) && r.indexOf('C') < r.indexOf(`D·${two.slice(-4)}`), JSON.stringify(r));

  // ③ 拖到一捆最后一条的下边缘 → 不绿 → 松手拆出来放在捆下面
  s = await drag(ids.B, async () => { const l = await center(task(ids.B === ids.B ? ids.G : ids.B)); const last = await page.evaluate((b) => [...document.querySelectorAll(`.task[data-bundle="${b}"]`)].pop().dataset.id, one); const c = await center(task(last)); return { x: c.x, y: c.bottom - 4 }; });
  check('③ 拖到捆的下边缘：不绿', s.green.length === 0, JSON.stringify(s));
  check('③ 松手 B 拆出来（捆一只剩 G 一条，自己散开）', (await bundleOf(ids.B)) === null && (await bundleOf(ids.G)) === null, JSON.stringify(await rows()));

  // ④ 散着的 A 拖进捆二中间（D 的下半截）→ 捆二整捆绿 → 松手 A 进捆二、插在 D 后面
  s = await drag(ids.A, async () => { const d = await center(task(ids.D)); return { x: d.x, y: d.bottom - d.h * 0.4 }; }, '4-拖进别的捆整捆绿.png');
  check('④ 拖进别的捆：那一整捆变绿', s.green.length === 1 && s.green[0] === two, JSON.stringify(s));
  r = await rows();
  check('④ 松手 A 进了捆二、插在 D 和 E 中间', (await bundleOf(ids.A)) === two && r.indexOf(`A·${two.slice(-4)}`) === r.indexOf(`D·${two.slice(-4)}`) + 1, JSON.stringify(r));

  // ⑤ 散着的 F 压在散着的 C 正中间 → C 变绿 → 松手 F 跟 C 捆成一捆
  s = await drag(ids.F, async () => center(task(ids.C)), '5-压在散条正中间.png');
  check('⑤ 压在散着的一条正中间：那一条变绿', s.target === 1 && s.green.length === 0, JSON.stringify(s));
  const fb = await bundleOf(ids.F);
  check('⑤ 松手 F 跟 C 捆成一捆', fb && fb === (await bundleOf(ids.C)), JSON.stringify(await rows()));
  console.log(failed ? `结果：${failed} 项没过` : '结果：全部验证点通过');
} finally {
  if (app) await app.close();
}
process.exit(failed ? 1 : 0);
