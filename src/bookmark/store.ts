// 书签台本地库：JSON 原子写，独立数据夹（<appDataRoot>\bookmark\），跟桌宠事件索引互不相干。
// 坏档不挡路：挪到 .corrupt-<时间戳> 存证后空库重来（照 events\event-journal 的先例）。

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { attachmentsRoot, bookmarksDataPath } from "../shared/paths";

import { reconcileImages } from "./inline-images";

const log = createLogger("bookmark");

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
}

/** 领活结果：record 为 null 表示没活可领（busy 是正在干的窗口名）。position/total 是这条在捆里第几条/共几条。 */
export interface ClaimResult {
  record: BookmarkRecord | null;
  position: number;
  total: number;
  /** 领完这条后，这一捆还剩几条没人领。 */
  remaining: number;
  busy: string[];
}

export class BookmarkStore {
  private records: BookmarkRecord[] = [];
  private readonly path: string;
  private loaded = false;

  constructor(path?: string) {
    this.path = path ?? bookmarksDataPath();
  }

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
    };
    const index = anchorId ? this.records.findIndex((item) => item.id === anchorId) : -1;
    if (index < 0) this.records.unshift(record);
    else if (place === "below") this.records.splice(index + 1, 0, record);
    else this.records.splice(index, 0, record);
    this.save();
    return record;
  }

  /** 把一条挪到另一条的上面或下面。顺序就是数组顺序，刷新还在。锚点没有或挪到自己身上则不动。 */
  move(id: string, anchorId: string, place: "above" | "below"): BookmarkRecord | null {
    this.ensureLoaded();
    const from = this.records.findIndex((item) => item.id === id);
    if (from < 0 || id === anchorId) return this.records[from] ?? null;
    const [item] = this.records.splice(from, 1);
    let to = this.records.findIndex((record) => record.id === anchorId);
    if (to < 0) {
      this.records.splice(from, 0, item);
      return item;
    }
    if (place === "below") to += 1;
    this.records.splice(to, 0, item);
    this.settleBundleAfterMove(item);
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
    if (groupKeyOf(item) !== groupKeyOf(target)) throw new Error("只能捆同一组的");
    const bundle = target.bundleId ?? `b-${randomUUID().slice(0, 6)}`;
    target.bundleId = bundle;
    this.records.splice(this.records.indexOf(item), 1);
    let last = -1;
    this.records.forEach((r, i) => { if (r.bundleId === bundle) last = i; });
    this.records.splice(last + 1, 0, item);
    item.bundleId = bundle;
    this.dissolveLoneBundles();
    this.save();
    return item;
  }

  /** 拆开一捆：里面每条都变回没捆。 */
  unbundle(bundleId: string): number {
    this.ensureLoaded();
    let n = 0;
    for (const r of this.records) {
      if (r.bundleId === bundleId) {
        r.bundleId = null;
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
    return this.claimFrom(candidates, who);
  }

  /** 按组领（睡觉档 `next --to 组名`）：这组从上到下第一条没人领、没报告过的；组名大小写不管。 */
  claimInGroup(group: string, by: string): ClaimResult {
    this.ensureLoaded();
    const who = String(by ?? "").trim();
    if (!who) throw new Error("缺窗口名（--by）");
    const key = String(group ?? "").trim().toLowerCase();
    if (!key) throw new Error("缺组名（--to）");
    return this.claimFrom(this.records.filter((r) => (r.assignee ?? "").toLowerCase() === key), who);
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
    record.report = words;
    record.reportedBy = who;
    record.reportedAt = new Date().toISOString();
    record.claimedBy = null;
    record.claimedAt = null;
    this.save();
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
    record.assignee = assignee ? String(assignee) : null;
    if (changed) {
      // 换了组：离开原来的捆，领活标记也作废（换了人干）。
      record.bundleId = null;
      record.claimedBy = null;
      record.claimedAt = null;
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
  }
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
