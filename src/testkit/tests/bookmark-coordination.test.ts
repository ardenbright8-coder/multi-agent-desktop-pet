import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { planNudges } from '../../bookmark/sleep-mode';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BookmarkStore } from '../../bookmark/store';

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'bm-coordination-')), 'bookmarks.json');
  const store = new BookmarkStore(file);
  const ids = [1, 2, 3, 4].map(n => store.add({ text: `任务${n}`, assignee: 'Pi Agent' }).id);
  const first = store.createTaskBundle(ids.slice(0, 2), '第一捆', '主窗');
  const second = store.createTaskBundle(ids.slice(2), '第二捆', '主窗');
  return { file, store, ids, first, second };
}

test('协同锁整捆，不能通过另一条或按组领取绕过', () => {
  const { store, ids, first } = fixture();
  const a = store.claimNext(first.id, '甲');
  assert.ok(a.record);
  assert.throws(() => store.claimNext(first.id, '乙'), /甲.*整捆/);
  assert.throws(() => store.claimNext(ids[0], '乙'), /甲.*整捆/);
  assert.equal(store.claimInGroup('Pi Agent', '乙').record, null);
  assert.equal(store.claimNext(first.id, '甲').record?.id, a.record.id);
});

test('报告后逐条推进，待审不删除、不释放整捆', () => {
  const { file, store, first } = fixture();
  const a = store.claimNext(first.id, '甲').record!;
  store.report(a.id, '甲', '已改代码；隔离测试通过；没有剩余问题');
  assert.equal(store.list().find(x => x.id === a.id)?.report?.includes('测试'), true);
  assert.throws(() => store.claimNext(first.id, '乙'), /甲.*整捆/);
  const b = store.claimNext(first.id, '甲').record!;
  assert.notEqual(a.id, b.id);
  const restarted = new BookmarkStore(file);
  assert.throws(() => restarted.claimNext(first.id, '乙'), /甲.*整捆/);
  restarted.report(b.id, '甲', '第二条测试通过');
  assert.equal(restarted.claimNext(first.id, '甲').record, null);
  assert.equal(restarted.list().length, 4);
  assert.equal(restarted.taskBundles().find(x => x.id === first.id)?.status, '待审核');
});

test('空闲另一捆可领，同工兵不能同时占两捆，原始材料与顺序保留', () => {
  const { store, first, second } = fixture();
  store.claimNext(first.id, '甲');
  assert.throws(() => store.claimNext(second.id, '甲'), /已有.*捆/);
  const b = store.claimTaskBundle('Pi Agent', '乙', '主窗');
  assert.equal(b.bundleId, second.id);
  assert.equal(b.record?.text, '任务4');
  assert.equal(store.claimTaskBundle('别组', '丙', '主窗').record, null);
  assert.equal(store.claimTaskBundle('Pi Agent', '丙', '别主窗').record, null);
});

test('忙捆不可拆、移动、改派、直接删或改原文；明确释放保留报告', () => {
  const { store, first, second } = fixture();
  const a = store.claimNext(first.id, '甲').record!;
  assert.throws(() => store.unbundle(first.id), /先放回/);
  assert.throws(() => store.setAssignee(a.id, 'Claude'), /先放回/);
  assert.throws(() => store.remove(a.id), /先放回/);
  assert.throws(() => store.updateText(a.id, '覆盖'), /先放回/);
  assert.throws(() => store.bundleWith(store.list().find(x => x.bundleId === second.id)!.id, a.id), /先放回/);
  assert.throws(() => store.releaseTaskBundle(first.id, '乙'), /甲/);
  store.report(a.id, '甲', '测试通过，待审核');
  store.releaseTaskBundle(first.id, '甲');
  assert.equal(store.list().find(x => x.id === a.id)?.report, '测试通过，待审核');
  assert.ok(store.claimNext(first.id, '乙').record);
});

test('普通捆保持原有单条领取；失败输入不修改任务', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'bm-ordinary-')), 'bookmarks.json');
  const store = new BookmarkStore(file);
  const a = store.add({ text: '普通一', assignee: 'Pi Agent' });
  const b = store.add({ text: '普通二', assignee: 'Pi Agent' });
  const bundle = store.bundleWith(a.id, b.id)!.bundleId!;
  assert.ok(store.claimNext(bundle, '甲').record);
  assert.ok(store.claimNext(bundle, '乙').record);
  const before = JSON.stringify(store.list());
  assert.throws(() => store.createTaskBundle([a.id, '不存在'], '坏捆', '主窗'));
  assert.equal(JSON.stringify(store.list()), before);
});

test('报告收件箱按调度窗口隔离，重启保留，错窗口不能确认通知', () => {
  const { store, file, first } = fixture();
  const a = store.claimNext(first.id, '甲').record!;
  store.report(a.id, '甲', '文件A已经修改，测试通过');
  const restarted = new BookmarkStore(file);
  assert.equal(restarted.taskNotices('主窗').length, 1);
  assert.equal(restarted.taskNotices('其他窗口').length, 0);
  const notice = restarted.taskNotices('主窗')[0];
  assert.throws(() => restarted.acknowledgeTaskNotice(notice.id, '其他窗口'));
  restarted.acknowledgeTaskNotice(notice.id, '主窗');
  assert.equal(restarted.taskNotices('主窗').length, 0);
});

test('协同捆不触发原睡觉档开窗；验收确认后只删除该捆', () => {
  const { store, first } = fixture();
  assert.equal(store.ordinaryTasks().length, 0);
  assert.deepEqual(planNudges(store.ordinaryTasks(), ['Pi Agent'], new Set()).launch, []);
  assert.throws(() => store.acceptTaskBundle(first.id, '主窗', '可以'), /未交报告/);
  for (let i = 0; i < 2; i++) {
    const current = store.claimNext(first.id, '甲').record!;
    store.report(current.id, '甲', '已自测，待调度审核');
  }
  assert.throws(() => store.acceptTaskBundle(first.id, '主窗', ''), /确认/);
  assert.throws(() => store.acceptTaskBundle(first.id, '乙', '可以'), /调度/);
  store.acceptTaskBundle(first.id, '主窗', '我测试过了，可以');
  assert.equal(store.list().length, 2);
  assert.equal(store.taskBundles().length, 1);
});

test('归属坏档保留任务并阻止抢活；窗口名不允许注入命令', () => {
  const { file, store, first } = fixture();
  assert.throws(() => store.claimNext(first.id, '甲";危险命令'), /窗口名/);
  writeFileSync(`${file}.coordination.json`, '{broken', 'utf8');
  const restarted = new BookmarkStore(file);
  assert.throws(() => restarted.claimNext(first.id, '乙'), /记录损坏/);
  assert.equal(restarted.list().length, 4);
});
