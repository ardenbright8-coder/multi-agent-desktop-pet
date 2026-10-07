// 看板派工入口：分捆、整捆领取、报告收件箱。只操作看板数据，不启动模型或新窗口。
import type { BookmarkStore } from './store';
import { composeForAgent } from './templates';
import { join } from 'node:path';
import { listBoardSkills, readBoardSkill } from './skills';

export interface DispatchInput {
  action: string;
  ids?: string[];
  name?: string;
  coordinator?: string;
  group?: string;
  by?: string;
  target?: string;
  seconds?: number;
  ok?: string;
}
export function parseDispatchArgs(argv: string[]): DispatchInput {
  const out: DispatchInput = { action: argv[1] ?? '' };
  if (!['bundle', 'list', 'next', 'release', 'accept', 'messages', 'wait', 'ack', 'skills', 'skill'].includes(out.action)) throw new Error('dispatch 用法：bundle --ids id1,id2 --name 名字 [--coordinator 调度窗口] | list | next --to 分组 --by 工兵窗口 --coordinator 调度窗口 | release 捆号 --by 原窗口或调度 | messages --coordinator 调度窗口 | ack 通知号 --coordinator 调度窗口');
  const keys: Record<string, keyof DispatchInput> = { '--name': 'name', '--coordinator': 'coordinator', '--to': 'group', '--by': 'by', '--ok': 'ok' };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') continue;
    if (flag === '--seconds') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 300) throw new Error('--seconds 取1至300秒');
      out.seconds = value;
    } else if (flag === '--ids') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--ids 后面写逗号分隔的任务编号');
      out.ids = value.split(',').map(x => x.trim()).filter(Boolean);
    } else if (keys[flag]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} 后面缺值`);
      (out as unknown as Record<string, unknown>)[keys[flag]] = value;
    } else if (!flag.startsWith('-') && !out.target) out.target = flag;
    else throw new Error(`不认识的派工参数：${flag}`);
  }
  if (out.action === 'wait' && !out.coordinator?.trim()) throw new Error('等待报告需要 --coordinator 调度窗口名');
  return out;
}
export function handleDispatchAction(store: BookmarkStore, input: DispatchInput) {
  const coord = String(input.coordinator ?? '').trim();
  switch (input.action) {
    case 'skills': return { ok: true, skills: listBoardSkills(join(__dirname, '..', '..', 'skills（AI用看板的说明书）')) };
    case 'skill': return { ok: true, skill: readBoardSkill(join(__dirname, '..', '..', 'skills（AI用看板的说明书）'), input.target ?? '') };
    case 'bundle': {
      if (input.coordinator != null && !coord) throw new Error('多人派工捆缺调度窗口名');
      return { ok: true, bundle: store.createTaskBundle(input.ids ?? [], input.name ?? '', coord || undefined) };
    }
    case 'list': return { ok: true, bundles: store.taskBundles().filter(b => !coord || b.coordinator === coord) };
    case 'next': {
      const got = store.claimTaskBundle(input.group ?? '', input.by ?? '', coord);
      return { ok: true, item: got.record, prompt: got.record ? composeForAgent(null, got.record) : null,
        position: got.position, total: got.total, remaining: got.remaining, busy: got.busy,
        bundleId: got.bundleId, coordinator: got.coordinator, cooperation: true };
    }
    case 'release': store.releaseTaskBundle(input.target ?? '', input.by ?? ''); return { ok: true };
    case 'accept': store.acceptTaskBundle(input.target ?? '', input.by ?? '', input.ok ?? ''); return { ok: true };
    case 'messages': return { ok: true, notices: store.taskNotices(coord) };
    case 'ack': store.acknowledgeTaskNotice(input.target ?? '', coord); return { ok: true };
    default: throw new Error('不认识的派工动作');
  }
}
