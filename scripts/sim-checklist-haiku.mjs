// 打勾清单真人流程模拟（2026-10-28）：Haiku 当接活的 AI，新旧流程各走一遍「A 窗口干两件 → 记一句放回 → B 窗口接着干完」，记 token。
// 新流程：交接单没清单 → 整理清单交进去 → 一项项勾 → 全勾完自动收掉。
// 旧流程：同一张单子当普通条目领（没清单、吐整段原话、干完要 done）。演练不真干活，只走看板命令。
// 隔离测试看板（AGENT_PET_ISOLATED），真看板不动。用法：node scripts/sim-checklist-haiku.mjs <单子 md 文件> [--只跑新]（取它的「## 详情」一节当原话）
// 结果写 .runtime/sim-checklist/结果.json，屏幕上打一张表。会开 4 个 claude -p --model haiku。
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const root = resolve(import.meta.dirname, '..');
const cliPath = join(root, 'scripts/bookmark-cli.mjs').split('\\').join('/');
const cliMod = require(join(root, 'dist/bookmark/cli-server.js'));
const tpl = require(join(root, 'dist/bookmark/templates.js'));
const ck = require(join(root, 'dist/bookmark/checklist.js'));
const src = process.argv[2];
if (!src || !existsSync(src)) { console.log('用法：node scripts/sim-checklist-haiku.mjs <单子 md 文件>'); process.exit(2); }
const raw = readFileSync(src, 'utf8');
const detail = (raw.split(/\n## 详情\n/)[1] ?? raw).split(/\n## /)[0].trim();
const title = (raw.match(/^# (.+)$/m) ?? [, '交接单'])[1];
const home = mkdtempSync(join(tmpdir(), 'bm-sim-'));
const out = join(root, '.runtime/sim-checklist');
mkdirSync(out, { recursive: true });

const drill = '这是流程演练：单子里的活不用真做，也别读、别改任何项目文件，每一项当成已经做完，只走看板命令。演练里要用户点头、要他说「可以」的地方，都当他已经说了「可以」，直接往下走。';
// 一个窗口：先发 prompt；它停下来问用户（末尾带问号），就替用户回「可以」接着跑（像真人点头），最多回 3 次。token 几次加起来。
function haiku(prompt, name) {
  const t0 = Date.now();
  const env = { ...process.env, AGENT_PET_HUB_HOME: home };
  delete env.CLAUDECODE;
  // 直接调 claude.exe，不走 shell：提示里的引号过 cmd 会被拆坏
  const exe = process.env.CLAUDE_EXE || 'D:/Dev/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const row = { name, 秒: 0, 轮: 0, 回可以: 0, 输入: 0, 缓存写: 0, 缓存读: 0, 输出: 0, 美元: 0, 末句: '' };
  let session = null;
  let say = prompt;
  for (let k = 0; k < 4; k++) {
    const args = ['-p', say, '--model', 'haiku', '--output-format', 'json', '--allowedTools', 'Bash', '--max-turns', '40', ...(session ? ['--resume', session] : [])];
    const r = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 600_000, cwd: home });
    let j = {};
    try { j = JSON.parse(r.stdout); } catch { j = { result: (r.stdout || r.stderr || '').slice(-400) }; }
    const u = j.usage ?? {};
    row.轮 += j.num_turns ?? 0;
    row.输入 += u.input_tokens ?? 0;
    row.缓存写 += u.cache_creation_input_tokens ?? 0;
    row.缓存读 += u.cache_read_input_tokens ?? 0;
    row.输出 += u.output_tokens ?? 0;
    row.美元 += j.total_cost_usd ?? 0;
    row.末句 = String(j.result ?? '').slice(-160);
    session = j.session_id ?? session;
    // 它问用户的那句常不在最末尾（「这个清单对吗？你说可以我就交进去」），看最后 120 个字里有没有问号
    if (!session || !/[？?]/.test(String(j.result ?? '').trim().slice(-120))) break;
    row.回可以 += 1;
    say = '可以，就按这个。';
  }
  row.秒 = Math.round((Date.now() - t0) / 1000);
  console.log(`· ${name}：${row.轮} 轮 ${row.秒} 秒（替用户回了 ${row.回可以} 次可以），输入 ${row.输入}+缓存写 ${row.缓存写}+缓存读 ${row.缓存读}，输出 ${row.输出}，$${row.美元.toFixed(4)}`);
  return row;
}

let app;
const rows = [];
const notes = {};
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'dist/app.js')], env: { ...process.env, AGENT_PET_ISOLATED: '1', AGENT_PET_HUB_HOME: home } });
  let page;
  for (let end = Date.now() + 15000; !page && Date.now() < end;) {
    page = app.windows().find(w => w.url().includes('bookmark/renderer'));
    if (!page) await new Promise(r => setTimeout(r, 100));
  }
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  for (let i = 0; i < 50 && !existsSync(join(home, 'bookmark', 'cli-port.json')); i++) await new Promise(r => setTimeout(r, 100));
  const list = () => page.evaluate(() => window.bookmark.list());
  await page.evaluate(async ({ title, detail }) => {
    await window.bookmark.add({ text: `【旧】${title}`, assignee: 'Claude', detail });
    await window.bookmark.add({ text: title, kind: 'handoff', detail });
  }, { title, detail });
  const all = await list();
  const oldId = all.find(r => r.text.startsWith('【旧】')).id;
  const newId = all.find(r => r.kind === 'handoff').id;
  const firstHalf = (id, by) => `接看板单子：node "${cliPath}" next ${id} --by ${by} ，领到后照吐回来的规矩干。${drill}规矩里要先做的准备（比如整理清单）照做，不算件事；单子里的活干完前 2 件，就当作上下文快满了要换窗口：用看板 log 命令记一句干到哪、下一步啥（node "${cliPath}" log ${id} --by ${by} --text "…"），再 release 放回去，停。`;
  const secondHalf = (id, by) => `接看板单子：node "${cliPath}" next ${id} --by ${by} ，领到后照吐回来的规矩把剩下的干完，直到单子从看板上收掉为止。${drill}`;
  const reclaim = async (id) => {
    const r = (await list()).find(x => x.id === id);
    if (!r) return null;
    const reply = { item: r, prompt: tpl.composeForAgent(null, r), position: 1, total: 1, remaining: 0, busy: [], lastProgress: ck.lastProgress(r), originalFile: r.checklist?.length ? 'X:/条目（原话）.md' : null, itemFile: 'X:/条目.md' };
    return cliMod.formatClaimMessage(reply, { cli: cliPath, target: id, by: 'B', coding: false }).length;
  };

  if (!process.argv.includes('--只跑新')) {
    rows.push(haiku(firstHalf(oldId, 'Haiku-旧A'), '旧流程 A（干两件放回）'));
    notes.旧_接手时吐的字数 = await reclaim(oldId);
    rows.push(haiku(secondHalf(oldId, 'Haiku-旧B'), '旧流程 B（接着干完）'));
    notes.旧_干完单子还在 = (await list()).some(r => r.id === oldId);
  }

  rows.push(haiku(firstHalf(newId, 'Haiku-新A'), '新流程 A（整理清单、干两件放回）'));
  const mid = (await list()).find(r => r.id === newId);
  notes.新_交了清单 = Boolean(mid?.checklist?.length);
  notes.新_清单 = mid?.checklist ? ck.formatChecklist(mid.checklist) : null;
  notes.新_接手时吐的字数 = await reclaim(newId);
  rows.push(haiku(secondHalf(newId, 'Haiku-新B'), '新流程 B（接着勾完）'));
  notes.新_全勾完自动收掉 = !(await list()).some(r => r.id === newId);
  const log = join(home, 'bookmark', '做完记录（最近50条·看板自动写）.md');
  notes.做完记录 = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('- ')) : [];
} catch (error) {
  console.log('✖ 跑挂了：', error?.message ?? error);
} finally {
  await app?.close().catch(() => {});
}
writeFileSync(join(out, process.argv.includes('--只跑新') ? '结果-只跑新.json' : '结果.json'), JSON.stringify({ rows, notes }, null, 2));
console.log(JSON.stringify(notes, null, 2));
console.log(`结果：${join(out, process.argv.includes('--只跑新') ? '结果-只跑新.json' : '结果.json')}`);
