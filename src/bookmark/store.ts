// 书签台本地库：JSON 原子写，独立数据夹（<appDataRoot>\bookmark\），跟桌宠事件索引互不相干。
// 坏档不挡路：挪到 .corrupt-<时间戳> 存证后空库重来（照 events\event-journal 的先例）。

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { attachmentsRoot, bookmarksDataPath } from "../shared/paths";

import { reconcileImages } from "./inline-images";
import { CoordinationStore } from "./coordination";
import type { TaskBundle } from "./coordination";

const log = createLogger("bookmark");
/** 正文里的贴图标记，起捆名时去掉。 */
const IMAGE_MARK = /\[图片:[^\]]*\]/g;

export interface BookmarkInput {
  text: string;
  url?: string | null;
  assignee?: string | null;
  /** 一样的 key 重复投递只记一条（手机端离线重发去重用）。 */
  dedupeKey?: string | null;
  /** 详情（交接单等长内容用）：看板上收起，点条目展开。缺省 null。 */
  detail?: string | null;
  /** 条目类型：note 普通记录（默认）/ handoff AI 交接单（看板显眼标记）。 */
  kind?: "note" | "handoff";
  /** 贴图文件名（不含路径）；真文件在 attachments\。创建时传入就按原样落盘，不拷贝。 */
  attachments?: string[];
}

export interface BookmarkRecord {
  id: string;
  text: string;
  url: string | null;
  assignee: string | null;
  dedupeKey: string | null;
  /** 详情（交接单等长内容）：板上收起，点条目展开；没有就是 null。 */
  detail: string | null;
  /** note 普通记录 / handoff AI 交接单（显眼标记）。旧库无此字段读入时回落 note。 */
  kind: "note" | "handoff";
  /** 贴图文件名（不含路径）。旧库无此字段读入时回落 []。 */
  attachments: string[];
  /** 捆号（2026-09-24 设定15）：同组里挨着的几条捆成一捆，一捆交给一个 AI 窗口。null = 没捆。 */
  bundleId: string | null;
  /** 谁领走了（看板开窗时起的窗口名，如 Claude-3）。null = 没人领。 */
  claimedBy: string | null;
  claimedAt: string | null;
  /** 睡觉档（设定18）：AI 干完写的大白话报告，挂在条目下面等用户早上审；审过说可以才删。null = 还没报告。 */
  report: string | null;
  reportedBy: string | null;
  reportedAt: string | null;
  createdAt: string;
  /** AI 整理（设定21）：AI 看过这条的时间。看过就不再送给它，不管捆没捆。null = 新条目。 */
  sortedAt: string | null;
  /** 用户亲手动过这条的捆（捆进、拆出、拖进拖出）。手动的说了算：AI 永远不碰它。 */
  userPinned: boolean;
}

/** 捆的名字和谁捆的（设定21）。多人派工捆的名字另在 coordination 里，这里也记一份给界面显示。 */
export interface BundleMeta {
  name: string;
  by: "user" | "ai";
}

/** 全部重来前存的原样（撤销重来用）。 */
interface ResetSnapshot {
  at: string;
  order: string[];
  rows: { id: string; bundleId: string | null; sortedAt: string | null; userPinned: boolean; group: string }[];
  meta: Record<string, BundleMeta>;
}

/** 领活结果：record 为 null 表示没活可领（busy 是正在干的窗口名）。position/total 是这条在捆里第几条/共几条。 */
export interface ClaimResult {
  record: BookmarkRecord | null;
  position: number;
  total: number;
  /** 领完这条后，这一捆还剩几条没人领。 */
  remaining: number;
  busy: string[];
  bundleId?: string;
  coordinator?: string;
}

export class BookmarkStore {
  private records: BookmarkRecord[] = [];
  private readonly path: string;
  private loaded = false;
  private readonly coordination: CoordinationStore;

  constructor(path?: string) {
    this.path = path ?? bookmarksDataPath();
    this.coordination = new CoordinationStore(`${this.path}.coordination.json`);
  }

  taskBundles(): TaskBundle[] {
    this.ensureLoaded();
    return this.coordination.list().filter(b => this.records.some(r => r.bundleId === b.id));
  }

  /** 成捆只调整归属和位置，原文、图片、报告保持不变。顺序沿用当前看板顺序。
   *  以最后一次为准（设定21）：选中的条目原来在别的捆里，就从原捆拿出来进新捆，原捆只剩一条就散掉。
   *  by=user（看板上手动捆，默认）会把这几条标成「用户动过」，AI 以后不碰。 */
  createTaskBundle(ids: string[], name: string, coordinator?: string, by: "user" | "ai" = "user"): TaskBundle {
    this.ensureLoaded();
    const chosen = new Set(ids);
    const items = this.records.filter(r => chosen.has(r.id));
    if (chosen.size < 2 || items.length !== chosen.size) throw new Error('至少选两条还在的任务才能成捆');
    if (items.some(r => groupKeyOf(r) !== groupKeyOf(items[0])) || groupKeyOf(items[0]) === 'inbox') {
      throw new Error('只能把同一个分组里的任务捆起来（待定区不捆）');
    }
    if (coordinator && (!items[0].assignee || items.some(r => r.kind !== 'note'))) {
      throw new Error('多人派工捆只能捆助手分组里的普通任务');
    }
    for (const r of items) {
      this.coordination.assertEditable(r.bundleId);
      if (r.claimedBy || r.report) throw new Error('在干或待审核的任务不能重新成捆');
    }
    const id = `b-${randomUUID().slice(0, 8)}`;
    const title = name.trim() || items[0].text.replace(IMAGE_MARK, '').trim().slice(0, 16) || '一捆';
    const result: TaskBundle = coordinator
      ? this.coordination.add(id, title, items[0].assignee!, coordinator)
      : { id, name: title, group: items[0].assignee ?? '交接单', coordinator: '', owner: null, status: '待领取' };
    const at = this.records.indexOf(items[0]);
    const rest = this.records.filter(r => !chosen.has(r.id));
    items.forEach(r => {
      r.bundleId = id;
      if (by === 'user') r.userPinned = true;
    });
    rest.splice(at, 0, ...items);
    this.records = rest;
    this.setBundleMeta(id, { name: title, by });
    this.dissolveLoneBundles();
    this.save();
    return result;
  }

  /** 捆名和谁捆的：界面捆头显示用。没登记过的捆（旧捆、拖出来的捆）不在里面，界面用第一条开头当名字。 */
  bundleMeta(): Record<string, BundleMeta> {
    this.ensureLoaded();
    return { ...this.loadMeta() };
  }

  // ── AI 整理（设定21）：只许这三个口子改捆，规矩在代码里卡死，AI 说什么都越不过去 ──

  /** 全部重来（设定21 第四版，2026-10-12 用户：全部推倒重来，不管我动没动过）：所有捆拆开，
   *  条目都变回「没看过、没动过」。有人在干、写了报告、多人派工占住的捆和条目不碰（挪了会搅乱正在干活的 AI）。
   *  拆之前存一份原样，撤销重来用。返回拆了几捆。 */
  aiResetAll(): number {
    this.ensureLoaded();
    const busy = (r: BookmarkRecord) => Boolean(r.claimedBy || r.report);
    const locked = new Set<string>();
    for (const r of this.records) {
      if (!r.bundleId) continue;
      if (this.coordination.get(r.bundleId) || busy(r)) locked.add(r.bundleId);
    }
    const snapshot: ResetSnapshot = {
      at: new Date().toISOString(),
      order: this.records.map((r) => r.id),
      rows: this.records.map((r) => ({ id: r.id, bundleId: r.bundleId, sortedAt: r.sortedAt, userPinned: r.userPinned, group: groupKeyOf(r) })),
      meta: { ...this.loadMeta() },
    };
    writeJsonAtomic(this.undoPath(), snapshot);
    const split = new Set<string>();
    for (const r of this.records) {
      if (busy(r) || (r.bundleId && locked.has(r.bundleId))) continue;
      if (r.bundleId) split.add(r.bundleId);
      r.bundleId = null;
      r.userPinned = false;
      r.sortedAt = null;
    }
    this.save();
    return split.size;
  }

  /** 有没有能撤销的「全部重来」。 */
  canUndoReset(): boolean {
    return existsSync(this.undoPath());
  }

  /** 下一次整理开始前调：撤销的机会过期了。 */
  dropResetUndo(): void {
    rmSync(this.undoPath(), { force: true });
  }

  /** 撤销重来：条目回到重来前的捆、顺序、看没看过、动没动过。重来以后新来的条目留在原地；
   *  这期间被领走、写了报告、换了组的不往回搬。返回搬回去几条。 */
  undoReset(): number {
    this.ensureLoaded();
    let snap: ResetSnapshot;
    try {
      snap = JSON.parse(readFileSync(this.undoPath(), "utf8")) as ResetSnapshot;
    } catch {
      throw new Error("没有能撤销的全部重来（下一次整理以后就撤不了了）");
    }
    const rows = new Map(snap.rows.map((r) => [r.id, r]));
    const rank = new Map(snap.order.map((id, i) => [id, i]));
    const restorable = (r: BookmarkRecord) => rows.has(r.id) && !r.claimedBy && !r.report && !this.coordination.get(r.bundleId);
    const slots: number[] = [];
    this.records.forEach((r, i) => { if (restorable(r)) slots.push(i); });
    const back = slots.map((i) => this.records[i]).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    slots.forEach((slot, k) => { this.records[slot] = back[k]; });
    for (const r of back) {
      const s = rows.get(r.id)!;
      r.bundleId = s.group === groupKeyOf(r) ? s.bundleId : null;
      r.sortedAt = s.sortedAt;
      r.userPinned = s.userPinned;
    }
    const meta = this.loadMeta();
    for (const [id, m] of Object.entries(snap.meta ?? {})) meta[id] = m;
    this.metaDirty = true;
    this.dissolveLoneBundles();
    this.compactBundles();
    this.save();
    this.dropResetUndo();
    return back.length;
  }

  /** 一捆的条目挨在一起：从这捆第一条的位置往下排。 */
  private compactBundles(): void {
    const out: BookmarkRecord[] = [];
    const done = new Set<string>();
    for (const r of this.records) {
      if (!r.bundleId) out.push(r);
      else if (!done.has(r.bundleId)) {
        done.add(r.bundleId);
        out.push(...this.records.filter((x) => x.bundleId === r.bundleId));
      }
    }
    this.records = out;
  }

  private undoPath(): string {
    return `${this.path}.reset-undo.json`;
  }

  /** 这几条 AI 看过了：以后不再送给它。 */
  markSorted(ids: string[]): void {
    this.ensureLoaded();
    const set = new Set(ids);
    const now = new Date().toISOString();
    let n = 0;
    for (const r of this.records) if (set.has(r.id) && !r.sortedAt) { r.sortedAt = now; n += 1; }
    if (n) this.save();
  }

  /** AI 能动的条目：散着、用户没动过、没人在干、没报告。 */
  aiMovable(record: BookmarkRecord | undefined): record is BookmarkRecord {
    return Boolean(record && !record.bundleId && !record.userPinned && !record.claimedBy && !record.report);
  }

  /** AI 能往里加条目的捆：还在、不是多人派工捆、里面没人在干、没报告。 */
  aiOpenBundle(bundleId: string): boolean {
    this.ensureLoaded();
    if (this.coordination.get(bundleId)) return false;
    const members = this.records.filter(r => r.bundleId === bundleId);
    return members.length >= 2 && members.every(r => !r.claimedBy && !r.report);
  }

  /** AI 把一条新条目放进已有的捆（捆到最后）。不合规矩直接抛错，整理那边接住跳过这一条。 */
  aiJoinBundle(id: string, bundleId: string): void {
    this.ensureLoaded();
    const item = this.records.find(r => r.id === id);
    if (!this.aiMovable(item)) throw new Error('这条 AI 不能动');
    if (!this.aiOpenBundle(bundleId)) throw new Error('这一捆 AI 不能往里加');
    const first = this.records.find(r => r.bundleId === bundleId)!;
    if (groupKeyOf(first) !== groupKeyOf(item)) throw new Error('不是同一组');
    this.records.splice(this.records.indexOf(item), 1);
    let last = -1;
    this.records.forEach((r, i) => { if (r.bundleId === bundleId) last = i; });
    this.records.splice(last + 1, 0, item);
    item.bundleId = bundleId;
    this.save();
  }

  /** AI 开一个新捆：每条都必须是 AI 能动的、同一组。 */
  aiCreateBundle(ids: string[], name: string): string {
    this.ensureLoaded();
    const items = ids.map(id => this.records.find(r => r.id === id));
    if (items.length < 2 || !items.every(r => this.aiMovable(r))) throw new Error('有条目 AI 不能动');
    return this.createTaskBundle(ids, name, undefined, 'ai').id;
  }

  /** AI 重写自己开的捆的名字（捆里加了条目后）。用户起名的、派工捆、AI 进不去的捆不改，返回 false。 */
  aiRenameBundle(bundleId: string, name: string): boolean {
    this.ensureLoaded();
    const meta = this.loadMeta()[bundleId];
    if (!meta || meta.by !== 'ai' || !this.aiOpenBundle(bundleId) || !name.trim()) return false;
    this.setBundleMeta(bundleId, { name: name.trim(), by: 'ai' });
    this.save();
    return true;
  }

  /** 协同入口只在明确指定的分组和调度窗口范围选捆，不捞其他任务。 */
  claimTaskBundle(group: string, by: string, coordinator: string): ClaimResult {
    if (!group.trim() || !by.trim() || !coordinator.trim()) throw new Error('缺分组、工兵窗口名或调度窗口名');
    const candidates = this.taskBundles().filter(b => b.group.toLowerCase() === group.toLowerCase() && b.coordinator === coordinator);
    const mine = candidates.find(b => b.owner === by && b.status === '执行中');
    const pick = mine ?? candidates.find(b => !b.owner && b.status !== '待审核');
    if (pick) return this.claimNext(pick.id, by);
    return { record: null, position: 0, total: 0, remaining: 0,
      busy: candidates.filter(b => b.owner && b.status === '执行中').map(b => b.owner!) };
  }

  releaseTaskBundle(id: string, by: string): void {
    this.ensureLoaded();
    this.coordination.release(id, by);
    for (const r of this.records.filter(r => r.bundleId === id)) {
      r.claimedBy = null;
      r.claimedAt = null;
    }
    this.save();
  }

  /** 用户验收后由调度清理整捆；不会把尚未报告的任务一起删除。 */
  acceptTaskBundle(id: string, by: string, userOk: string): void {
    this.ensureLoaded();
    const b = this.coordination.get(id);
    if (!b || b.coordinator !== by.trim()) throw new Error('只有本捆调度窗口能登记验收');
    if (!userOk.trim()) throw new Error('缺用户验收确认（--ok）');
    const items = this.records.filter(r => r.bundleId === id);
    if (!items.length || items.some(r => !r.report || r.claimedBy)) throw new Error('还有未交报告或正在干的任务，不能整捆删除');
    this.coordination.release(id, by);
    this.records = this.records.filter(r => r.bundleId !== id);
    this.save();
    this.coordination.remove(id);
    for (const r of items) if (r.dedupeKey) this.rememberRemoved(r.dedupeKey);
  }

  /** 原睡觉档只处理普通任务，协同捆绝不触发后台开窗。 */
  ordinaryTasks(): BookmarkRecord[] { return this.list().filter(r => !this.coordination.get(r.bundleId)); }

  taskNotices(coordinator: string) { return this.coordination.notices(coordinator); }
  acknowledgeTaskNotice(id: string, coordinator: string): void { this.coordination.acknowledge(id, coordinator); }

  /** 新→旧排好的一份快照。 */
  list(): BookmarkRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  add(input: BookmarkInput): BookmarkRecord {
    this.ensureLoaded();
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("书签内容不能为空");
    const dedupeKey = input.dedupeKey ? String(input.dedupeKey) : null;
    if (dedupeKey) {
      const existing = this.records.find((record) => record.dedupeKey === dedupeKey);
      if (existing) return existing;
    }
    const record: BookmarkRecord = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      text,
      url: input.url ? String(input.url) : null,
      assignee: input.assignee ? String(input.assignee) : null,
      dedupeKey,
      detail: input.detail ? String(input.detail) : null,
      kind: input.kind === "handoff" ? "handoff" : "note",
      attachments: reconcileImages(normalizeAttachmentNames(input.attachments), "", text),
      bundleId: null,
      claimedBy: null,
      claimedAt: null,
      report: null,
      reportedBy: null,
      reportedAt: null,
      createdAt: new Date().toISOString(),
      sortedAt: null,
      userPinned: false,
    };
    this.records.unshift(record);
    this.save();
    return record;
  }

  /** 插在某条的上面或下面。锚点没有就放到最前。右键白条上半/下半用这个，不总是堆到顶上。 */
  insertBeside(anchorId: string | null, place: "above" | "below", input: BookmarkInput): BookmarkRecord {
    this.ensureLoaded();
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("书签内容不能为空");
    const record: BookmarkRecord = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      text,
      url: input.url ? String(input.url) : null,
      assignee: input.assignee ? String(input.assignee) : null,
      dedupeKey: input.dedupeKey ? String(input.dedupeKey) : null,
      detail: input.detail ? String(input.detail) : null,
      kind: input.kind === "handoff" ? "handoff" : "note",
      attachments: reconcileImages(normalizeAttachmentNames(input.attachments), "", text),
      bundleId: null,
      claimedBy: null,
      claimedAt: null,
      report: null,
      reportedBy: null,
      reportedAt: null,
      createdAt: new Date().toISOString(),
      sortedAt: null,
      userPinned: false,
    };
    const index = anchorId ? this.records.findIndex((item) => item.id === anchorId) : -1;
    if (index < 0) this.records.unshift(record);
    else if (place === "below") this.records.splice(index + 1, 0, record);
    else this.records.splice(index, 0, record);
    this.save();
    return record;
  }

  /** 把一条挪到另一条的上面或下面。顺序就是数组顺序，刷新还在。锚点没有或挪到自己身上则不动。
   *  into（2026-10-13 拖动改版：变绿＝合并、不绿＝单独放）：捆号＝放进这捆，null＝单独放（在捆里就拆出来），
   *  不传＝按两边邻居推断（老办法，命令行、旧界面用）。 */
  move(id: string, anchorId: string, place: "above" | "below", into?: string | null): BookmarkRecord | null {
    this.ensureLoaded();
    const from = this.records.findIndex((item) => item.id === id);
    if (from < 0 || id === anchorId) return this.records[from] ?? null;
    this.coordination.assertEditable(this.records[from].bundleId);
    this.coordination.assertEditable(this.records.find(r => r.id === anchorId)?.bundleId);
    const [item] = this.records.splice(from, 1);
    let to = this.records.findIndex((record) => record.id === anchorId);
    if (to < 0) {
      this.records.splice(from, 0, item);
      return item;
    }
    if (place === "below") to += 1;
    this.records.splice(to, 0, item);
    const before = item.bundleId;
    if (into === undefined) this.settleBundleAfterMove(item);
    else this.placeExplicitly(item, into);
    if (item.bundleId !== before) item.userPinned = true;
    this.dissolveLoneBundles();
    this.save();
    return item;
  }

  /** 捆一捆：把 id 这条捆到 targetId 那条所在的捆（没捆就新起一捆），挪到那一捆的最后。只许同一组。 */
  bundleWith(id: string, targetId: string): BookmarkRecord | null {
    this.ensureLoaded();
    if (id === targetId) return null;
    const item = this.records.find((r) => r.id === id);
    const target = this.records.find((r) => r.id === targetId);
    if (!item || !target) return null;
    this.coordination.assertEditable(item.bundleId);
    this.coordination.assertEditable(target.bundleId);
    if (groupKeyOf(item) !== groupKeyOf(target)) throw new Error("只能捆同一组的");
    const bundle = target.bundleId ?? `b-${randomUUID().slice(0, 6)}`;
    target.bundleId = bundle;
    this.records.splice(this.records.indexOf(item), 1);
    let last = -1;
    this.records.forEach((r, i) => { if (r.bundleId === bundle) last = i; });
    this.records.splice(last + 1, 0, item);
    item.bundleId = bundle;
    item.userPinned = true;
    target.userPinned = true;
    this.dissolveLoneBundles();
    this.save();
    return item;
  }

  /** 拆开一捆：里面每条都变回没捆。 */
  unbundle(bundleId: string): number {
    this.ensureLoaded();
    this.coordination.assertEditable(bundleId);
    if (this.coordination.get(bundleId)) this.coordination.remove(bundleId);
    let n = 0;
    for (const r of this.records) {
      if (r.bundleId === bundleId) {
        r.bundleId = null;
        r.userPinned = true;
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }

  /** 领活：target 是捆号就在这一捆里按顺序领，是条目 id 就领这一条。
   *  同一个窗口手里有没干完的，再领还给它那条（不多领）；别人领走的跳过。 */
  claimNext(target: string, by: string): ClaimResult {
    this.ensureLoaded();
    const who = String(by ?? "").trim();
    if (!who) throw new Error("缺窗口名（--by）");
    const inBundle = this.records.filter((r) => r.bundleId === target);
    const candidates = inBundle.length ? inBundle : this.records.filter((r) => r.id === target);
    if (!candidates.length) throw new Error(`找不到 ${target}（这一捆或这一条可能已经干完删掉了）`);
    const bundleId = candidates[0].bundleId;
    const controlled = this.coordination.get(bundleId);
    if (controlled) {
      this.coordination.claim(controlled.id, who);
      const all = this.records.filter(r => r.bundleId === controlled.id);
      const got = this.claimFrom(all, who);
      return { ...got, position: got.record ? all.findIndex(r => r.id === got.record!.id) + 1 : 0,
        total: all.length, bundleId: controlled.id, coordinator: controlled.coordinator };
    }
    return this.claimFrom(candidates, who);
  }

  /** 按组领（睡觉档 `next --to 组名`）：这组从上到下第一条没人领、没报告过的；组名大小写不管。 */
  claimInGroup(group: string, by: string): ClaimResult {
    this.ensureLoaded();
    const who = String(by ?? "").trim();
    if (!who) throw new Error("缺窗口名（--by）");
    const key = String(group ?? "").trim().toLowerCase();
    if (!key) throw new Error("缺组名（--to）");
    return this.claimFrom(this.records.filter((r) => (r.assignee ?? "").toLowerCase() === key && !this.coordination.get(r.bundleId)), who);
  }

  /** 领活的共同规矩：报告过的不算活；自己手里有没干完的还给它那条；别人领走的跳过。 */
  private claimFrom(all: BookmarkRecord[], who: string): ClaimResult {
    const candidates = all.filter((r) => !r.report);
    const total = candidates.length;
    const mine = candidates.find((r) => r.claimedBy === who);
    const pick = mine ?? candidates.find((r) => !r.claimedBy) ?? null;
    if (pick && !mine) {
      pick.claimedBy = who;
      pick.claimedAt = new Date().toISOString();
      this.save();
    }
    return {
      record: pick,
      position: pick ? candidates.indexOf(pick) + 1 : 0,
      total,
      remaining: candidates.filter((r) => !r.claimedBy).length,
      busy: [...new Set(candidates.filter((r) => r.claimedBy && r.claimedBy !== who).map((r) => r.claimedBy as string))],
    };
  }

  /** 干完：只有领它的窗口能删，而且必须带上用户说「可以」的原话。删掉返回那条。 */
  done(id: string, by: string, userOk: string): BookmarkRecord {
    this.ensureLoaded();
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error("没找到这条（可能已经删了）");
    if (record.claimedBy !== String(by ?? "").trim()) throw new Error(`这条不是你领的（现在是 ${record.claimedBy ?? "没人"} 在干）`);
    if (!String(userOk ?? "").trim()) throw new Error("缺用户确认：先把做了啥、怎么验告诉用户，等他说可以，再把他的原话放进 --ok");
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
    return record;
  }

  /** 睡觉档干完（设定18）：领的人写大白话报告，条目标成干完待审、不删，领活标记清掉，早上用户看了说可以再删。 */
  report(id: string, by: string, text: string): BookmarkRecord {
    this.ensureLoaded();
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error("没找到这条（可能已经删了）");
    const who = String(by ?? "").trim();
    if (record.claimedBy !== who) throw new Error(`这条不是你领的（现在是 ${record.claimedBy ?? "没人"} 在干）`);
    const words = String(text ?? "").trim();
    if (!words) throw new Error("报告是空的：用大白话写做了啥、改了哪些、怎么验的、还有啥没弄完");
    const bundle = this.coordination.get(record.bundleId);
    if (bundle && bundle.owner !== who) throw new Error('这捆不属于当前报告窗口');
    record.report = words;
    record.reportedBy = who;
    record.reportedAt = new Date().toISOString();
    record.claimedBy = null;
    record.claimedAt = null;
    this.save();
    if (bundle) {
      const allReported = this.records.filter(r => r.bundleId === bundle.id).every(r => Boolean(r.report));
      this.coordination.report(bundle.id, id, who, words, allReported);
    }
    return record;
  }

  /** 放回去：清掉领活标记（窗口半路关了、或 AI 说干不了）。 */
  release(id: string): BookmarkRecord | null {
    this.ensureLoaded();
    const record = this.records.find((r) => r.id === id);
    if (!record) return null;
    record.claimedBy = null;
    record.claimedAt = null;
    this.save();
    return record;
  }

  /** 挪完之后定它在不在捆里：夹在同一捆两条中间＝进这捆；本来在捆里、挪到捆边上还挨着＝留下；别的都＝离开。 */
  /** 拖动时界面已经说清了进哪捆还是单独放：照办，再把位置理顺，免得一捆被插断成两截。 */
  private placeExplicitly(item: BookmarkRecord, into: string | null): void {
    const key = groupKeyOf(item);
    const members = into ? this.records.filter((r) => r !== item && r.bundleId === into && groupKeyOf(r) === key) : [];
    if (into && members.length) this.coordination.assertEditable(into);
    const target = members.length ? into : null;
    const same = this.records.filter((r) => groupKeyOf(r) === key);
    const at = same.indexOf(item);
    const prev = same[at - 1]?.bundleId ?? null;
    const next = same[at + 1]?.bundleId ?? null;
    const stray = target ? prev !== target && next !== target : Boolean(prev && prev === next);
    if (stray) {
      // 进捆却没挨着这捆 → 挪到这捆最后；单独放却夹在一捆中间 → 挪到那捆后面
      const bundle = target ?? prev!;
      this.records.splice(this.records.indexOf(item), 1);
      let last = -1;
      this.records.forEach((r, i) => { if (r.bundleId === bundle) last = i; });
      this.records.splice(last + 1, 0, item);
    }
    item.bundleId = target;
  }

  private settleBundleAfterMove(item: BookmarkRecord): void {
    const key = groupKeyOf(item);
    const same = this.records.filter((r) => groupKeyOf(r) === key);
    const at = same.indexOf(item);
    const prev = same[at - 1]?.bundleId ?? null;
    const next = same[at + 1]?.bundleId ?? null;
    if (prev && prev === next) item.bundleId = prev;
    else if (item.bundleId && (prev === item.bundleId || next === item.bundleId)) return;
    else item.bundleId = null;
  }

  /** 用户挪来挪去以后，只剩一条的捆就散了（AI 干完删条目不走这里：最后一条还要能按捆号领）。 */
  private dissolveLoneBundles(): void {
    const counts = new Map<string, number>();
    for (const r of this.records) if (r.bundleId) counts.set(r.bundleId, (counts.get(r.bundleId) ?? 0) + 1);
    for (const r of this.records) if (r.bundleId && (counts.get(r.bundleId) ?? 0) < 2) r.bundleId = null;
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    const gone = this.records.find((record) => record.id === id);
    if (!gone) return false;
    this.coordination.assertEditable(gone.bundleId);
    this.records = this.records.filter((record) => record.id !== id);
    this.save();
    if (gone.dedupeKey) this.rememberRemoved(gone.dedupeKey);
    return true;
  }

  // ── 删过的手机条目（2026-09-25 修「删了又回来」）：看板重开会从中转站重收老消息，查重只比现存条目，删过的就复活。
  // 删手机发来的那条时记下它的 dedupeKey（存盘、最多 2000 个），同一条再来，收信那边直接不收。

  private removedKeys: string[] | null = null;

  private removedPath(): string {
    return `${this.path}.removed-keys.json`;
  }

  private loadRemoved(): string[] {
    if (this.removedKeys) return this.removedKeys;
    try {
      const parsed: unknown = existsSync(this.removedPath()) ? JSON.parse(readFileSync(this.removedPath(), "utf8")) : [];
      this.removedKeys = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
    } catch {
      this.removedKeys = [];
    }
    return this.removedKeys;
  }

  /** 这条手机消息对应的条目是不是被删过。 */
  wasRemoved(dedupeKey: string): boolean {
    return this.loadRemoved().includes(dedupeKey);
  }

  private rememberRemoved(dedupeKey: string): void {
    const keys = this.loadRemoved();
    if (keys.includes(dedupeKey)) return;
    keys.push(dedupeKey);
    if (keys.length > 2000) keys.splice(0, keys.length - 2000);
    try {
      writeJsonAtomic(this.removedPath(), keys);
    } catch (error) {
      log.出事("删过的条目记不下来（重开看板它可能回来）", error, "store");
    }
  }

  /** 把源图拷进 bookmark\attachments\（文件名加条目 id 前缀防撞），再追到该条 attachments。没这条返 null。 */
  addAttachment(id: string, sourcePath: string): BookmarkRecord | null {
    this.ensureLoaded();
    const record = this.records.find((item) => item.id === id);
    if (!record) return null;
    const src = String(sourcePath ?? "").trim();
    if (!src || !existsSync(src) || !statSync(src).isFile()) {
      throw new Error("贴图源文件不存在");
    }
    const dir = attachmentsRoot();
    mkdirSync(dir, { recursive: true });
    const stored = uniqueAttachmentName(dir, record.id, src);
    copyFileSync(src, join(dir, stored));
    record.attachments = [...record.attachments, stored];
    this.save();
    return record;
  }

  setAssignee(id: string, assignee: string | null): BookmarkRecord | null {
    this.ensureLoaded();
    const record = this.records.find((item) => item.id === id);
    if (!record) return null;
    const changed = (record.assignee ?? "").toLowerCase() !== (assignee ?? "").toLowerCase();
    if (changed) this.coordination.assertEditable(record.bundleId);
    record.assignee = assignee ? String(assignee) : null;
    if (changed) {
      // 换了组：离开原来的捆，领活标记也作废（换了人干）。
      record.bundleId = null;
      record.claimedBy = null;
      record.claimedAt = null;
      record.sortedAt = null;
      record.userPinned = false;
      this.dissolveLoneBundles();
    }
    this.save();
    return record;
  }

  /** 改一条的正文/链接（看板输入行自动存档用，2026-09-11 改版三：同一份草稿跟着改同一条，
   *  不另开新条；清空由 renderer 走 remove，这里空文照样拒）。找不到返回 null。 */
  updateText(id: string, text: string, url?: string | null): BookmarkRecord | null {
    this.ensureLoaded();
    const record = this.records.find((item) => item.id === id);
    if (!record) return null;
    this.coordination.assertEditable(record.bundleId);
    const next = String(text ?? "").trim();
    if (!next) throw new Error("书签内容不能为空");
    record.attachments = reconcileImages(record.attachments, record.text, next);
    record.text = next;
    record.url = url ? String(url) : null;
    this.save();
    return record;
  }

  count(): number {
    this.ensureLoaded();
    return this.records.length;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.records = this.loadFromDisk();
    this.loaded = true;
  }

  private loadFromDisk(): BookmarkRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("书签库顶层不是数组");
      // 旧库没有 kind/detail/attachments 字段：读入时补齐默认（note/无详情/无图），内存里字段永远完整。
      return parsed
        .filter(isRecord)
        .map((record) => ({
          ...record,
          detail: typeof record.detail === "string" ? record.detail : null,
          kind: record.kind === "handoff" ? "handoff" : "note",
          attachments: reconcileImages(normalizeAttachmentNames(record.attachments), "", record.text),
          bundleId: typeof record.bundleId === "string" ? record.bundleId : null,
          claimedBy: typeof record.claimedBy === "string" ? record.claimedBy : null,
          claimedAt: typeof record.claimedAt === "string" ? record.claimedAt : null,
          report: typeof record.report === "string" ? record.report : null,
          reportedBy: typeof record.reportedBy === "string" ? record.reportedBy : null,
          reportedAt: typeof record.reportedAt === "string" ? record.reportedAt : null,
          sortedAt: typeof record.sortedAt === "string" ? record.sortedAt : null,
          userPinned: record.userPinned === true,
        }));
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.path, backup);
        log.出事("书签库读取失败，坏档已存证，从空库重来", error, "load");
      } catch {
        // 挪不动就让它躺着，别拦启动。
        log.出事("书签库读取失败，且坏档存证也失败", error, "load");
      }
      return [];
    }
  }

  private save(): void {
    writeJsonAtomic(this.path, this.records);
    this.pruneMeta();
  }

  // ── 捆名（设定21）：存 bookmarks.json.bundle-meta.json，坏档当空的，不拦看板 ──

  private meta: Record<string, BundleMeta> | null = null;

  private metaPath(): string {
    return `${this.path}.bundle-meta.json`;
  }

  private loadMeta(): Record<string, BundleMeta> {
    if (this.meta) return this.meta;
    try {
      const parsed: unknown = existsSync(this.metaPath()) ? JSON.parse(readFileSync(this.metaPath(), "utf8").replace(/^\uFEFF/, "")) : {};
      const out: Record<string, BundleMeta> = {};
      if (parsed && typeof parsed === "object") {
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          const m = v as Partial<BundleMeta> | null;
          if (m && typeof m.name === "string") out[id] = { name: m.name, by: m.by === "ai" ? "ai" : "user" };
        }
      }
      this.meta = out;
    } catch {
      this.meta = {};
    }
    return this.meta;
  }

  private setBundleMeta(id: string, value: BundleMeta): void {
    this.loadMeta()[id] = value;
    this.metaDirty = true;
  }

  private pruneMeta(): void {
    const meta = this.loadMeta();
    const alive = new Set(this.records.map((r) => r.bundleId).filter(Boolean));
    let changed = false;
    for (const id of Object.keys(meta)) if (!alive.has(id)) { delete meta[id]; changed = true; }
    if (!changed && !this.metaDirty) return;
    this.metaDirty = false;
    try {
      writeJsonAtomic(this.metaPath(), meta);
    } catch (error) {
      log.出事("捆名存不下来（捆还在，只是名字回落成第一条开头）", error, "store");
    }
  }

  private metaDirty = false;
}

/** 看板上在同一组的判据：派给谁（大小写不敏感）；没派的交接单一组、没派的普通条目一组。 */
function groupKeyOf(record: BookmarkRecord): string {
  if (record.assignee) return `a:${record.assignee.toLowerCase()}`;
  return record.kind === "handoff" ? "handoff" : "inbox";
}

function isRecord(value: unknown): value is BookmarkRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.text === "string" && typeof record.createdAt === "string";
}

/** JSON 只存文件名：丢掉路径，空名/. /.. 丢掉。 */
function normalizeAttachmentNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    const name = basename(String(item ?? "").trim());
    if (!name || name === "." || name === "..") continue;
    names.push(name);
  }
  return names;
}

/** `${条目id}-${原文件名}`，重名再加 -n 防撞。 */
function uniqueAttachmentName(dir: string, id: string, sourcePath: string): string {
  const original = basename(sourcePath).trim() || "image";
  let stored = `${id}-${original}`;
  let n = 1;
  while (existsSync(join(dir, stored))) {
    const ext = extname(original);
    const stem = original.slice(0, original.length - ext.length) || "image";
    stored = `${id}-${stem}-${n}${ext}`;
    n += 1;
  }
  return stored;
}
