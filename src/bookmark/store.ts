// 书签台本地库：JSON 原子写，独立数据夹（<appDataRoot>\bookmark\），跟桌宠事件索引互不相干。
// 坏档不挡路：挪到 .corrupt-<时间戳> 存证后空库重来（照 events\event-journal 的先例）。

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { bookmarksDataPath } from "../shared/paths";

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
  createdAt: string;
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
      createdAt: new Date().toISOString(),
    };
    this.records.unshift(record);
    this.save();
    return record;
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  setAssignee(id: string, assignee: string | null): BookmarkRecord | null {
    this.ensureLoaded();
    const record = this.records.find((item) => item.id === id);
    if (!record) return null;
    record.assignee = assignee ? String(assignee) : null;
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
      // 旧库没有 kind/detail 字段：读入时补齐默认（note/无详情），内存里字段永远完整。
      return parsed
        .filter(isRecord)
        .map((record) => ({
          ...record,
          detail: typeof record.detail === "string" ? record.detail : null,
          kind: record.kind === "handoff" ? "handoff" : "note",
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

function isRecord(value: unknown): value is BookmarkRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.text === "string" && typeof record.createdAt === "string";
}
