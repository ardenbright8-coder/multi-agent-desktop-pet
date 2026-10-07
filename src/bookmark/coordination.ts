// 多人看板派工的整捆归属与调度收件箱。普通捆不登记，日常领活保持原样。
// 元数据按捆只存一份，随看板数据原子落盘；没有超时抢锁或后台开窗。
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../shared/atomic-file';
import { randomUUID } from 'node:crypto';

export interface TaskBundle {
  id: string;
  name: string;
  group: string;
  coordinator: string;
  owner: string | null;
  status: '待领取' | '执行中' | '待审核';
}
export interface TaskNotice {
  id: string;
  coordinator: string;
  bundleId: string;
  taskId: string;
  worker: string;
  report: string;
  createdAt: string;
}
interface State { bundles: TaskBundle[]; notices: TaskNotice[] }
function windowName(value: string): string {
  const name = String(value ?? '').trim();
  if (!name || name.length > 120 || /["\r\n\x00-\x1f]/.test(name)) throw new Error('窗口名不能为空、不能包含引号或控制字符，最长120字');
  return name;
}

export class CoordinationStore {
  private data: State | null = null;
  constructor(private readonly path: string) {}
  private state(): State {
    if (this.data) return this.data;
    if (!existsSync(this.path)) return this.data = { bundles: [], notices: [] };
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(s.bundles) || !Array.isArray(s.notices)
        || s.bundles.some((b: TaskBundle) => !b || typeof b.id !== 'string' || typeof b.coordinator !== 'string'
          || typeof b.group !== 'string' || typeof b.name !== 'string'
          || (b.owner !== null && typeof b.owner !== 'string')
          || !['待领取', '执行中', '待审核'].includes(b.status))
        || s.notices.some((n: TaskNotice) => !n || typeof n.id !== 'string' || typeof n.coordinator !== 'string')) {
        throw new Error('格式错误');
      }
      return this.data = s;
    } catch {
      // 坏档不能回落空锁，否则会把仍在写代码的捆交给另一个窗口。
      throw new Error('派工归属记录损坏，已保留原文件；修复记录前不能领取或改动任务');
    }
  }
  list(): TaskBundle[] { return this.state().bundles.map(b => ({ ...b })); }
  get(id: string | null | undefined): TaskBundle | undefined {
    return id ? this.state().bundles.find(b => b.id === id) : undefined;
  }
  add(id: string, name: string, group: string, coordinator: string): TaskBundle {
    const coordinatorName = windowName(coordinator);
    const b: TaskBundle = { id, name, group, coordinator: coordinatorName, owner: null, status: '待领取' };
    this.state().bundles.push(b);
    this.save();
    return { ...b };
  }
  assertEditable(id: string | null | undefined): void {
    const b = this.get(id);
    if (b?.owner) throw new Error(`「${b.name}」由 ${b.owner} 占住整捆；先放回整捆才能挪动、改派、拆开或改字`);
  }
  claim(id: string, by: string): TaskBundle {
    const who = windowName(by);
    const b = this.get(id);
    if (!b) throw new Error('不是多人派工捆');
    if (b.owner && b.owner !== who) throw new Error(`${b.owner} 已占住整捆「${b.name}」，请领其他空闲捆`);
    const other = this.state().bundles.find(x => x.id !== id && x.owner === who && x.status === '执行中');
    if (other) throw new Error(`你已有「${other.name}」这一捆在干，先完成或放回，不能同时领另一捆`);
    b.owner = who;
    if (b.status !== '待审核') b.status = '执行中';
    this.save();
    return { ...b };
  }
  release(id: string, by: string): void {
    const b = this.get(id);
    if (!b) throw new Error('找不到派工捆');
    if (b.owner && b.owner !== by.trim() && b.coordinator !== by.trim()) throw new Error(`这捆属于 ${b.owner}，只有原工兵或调度 ${b.coordinator} 能放回`);
    b.owner = null;
    if (b.status !== '待审核') b.status = '待领取';
    this.save();
  }
  remove(id: string): void {
    this.assertEditable(id);
    this.state().bundles = this.state().bundles.filter(b => b.id !== id);
    this.save();
  }
  report(id: string, taskId: string, by: string, report: string, allReported: boolean): void {
    const b = this.get(id);
    if (!b || b.owner !== by) throw new Error('报告窗口不属于这捆');
    if (allReported) b.status = '待审核';
    this.state().notices.push({ id: randomUUID(), coordinator: b.coordinator, bundleId: id,
      taskId, worker: by, report, createdAt: new Date().toISOString() });
    this.save();
  }
  notices(coordinator: string): TaskNotice[] {
    if (!coordinator.trim()) throw new Error('缺调度窗口名');
    return this.state().notices.filter(n => n.coordinator === coordinator).map(n => ({ ...n }));
  }
  acknowledge(id: string, coordinator: string): void {
    const n = this.state().notices.find(n => n.id === id);
    if (!n || n.coordinator !== coordinator) throw new Error('通知不属于这个调度窗口');
    this.state().notices = this.state().notices.filter(n => n.id !== id);
    this.save();
  }
  private save(): void { writeJsonAtomic(this.path, this.state()); }
}
