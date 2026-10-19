// 纯数据层：同账号多来源合并；只保存读数，不保存邮箱、cookie或聊天正文。
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "../shared/atomic-file";

export const SOURCE_TTL = 180_000;
export const STALE_AFTER = 12 * 60_000;
export interface QuotaValue { used: number; reset: { raw: string; epoch: number | null } }
export interface QuotaMessage {
  kind: "reading" | "bye"; accountId: string; sourceId: string; monitor?: boolean;
  current?: QuotaValue; weekly?: QuotaValue | null; observedAt?: number; sourceUpdated?: string;
}
export interface QuotaRow {
  accountId: string; label: string; current: QuotaValue; weekly: QuotaValue | null;
  observedAt: number; sourceUpdated: string; stale: boolean;
}
type Saved = Omit<QuotaRow, "stale">;
function value(input: unknown): QuotaValue | null {
  const v = input as QuotaValue;
  if (!v || !Number.isFinite(v.used) || v.used < 0 || v.used > 100 || !v.reset
    || typeof v.reset.raw !== "string" || v.reset.raw.length > 96
    || !(v.reset.epoch === null || Number.isFinite(v.reset.epoch))) return null;
  return { used: v.used, reset: { raw: v.reset.raw, epoch: v.reset.epoch } };
}
export function normalizeMessage(input: unknown, now = Date.now()): QuotaMessage | null {
  if (!input || typeof input !== "object") return null;
  const m = input as QuotaMessage;
  if (!/^[a-f0-9]{8,64}$/.test(m.accountId || "") || !/^[a-zA-Z0-9-]{8,80}$/.test(m.sourceId || "")) return null;
  if (m.kind === "bye") return { kind: "bye", accountId: m.accountId, sourceId: m.sourceId };
  const current = value(m.current), weekly = m.weekly == null ? null : value(m.weekly);
  if (m.kind !== "reading" || !current || m.weekly != null && !weekly || !Number.isFinite(m.observedAt)
    || m.observedAt! > now + 120_000 || now - m.observedAt! > 24 * 3600_000) return null;
  return { kind: "reading", accountId: m.accountId, sourceId: m.sourceId, monitor: m.monitor === true, current, weekly,
    observedAt: m.observedAt, sourceUpdated: typeof m.sourceUpdated === "string" ? m.sourceUpdated.slice(0, 96) : "" };
}
export class QuotaStore {
  private readings = new Map<string, Saved>();
  private sources = new Map<string, { accountId: string; at: number; monitor: boolean }>();
  constructor(private file?: string) {
    if (!file) return;
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as Saved[];
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(0, 8)) {
        const m = normalizeMessage({ ...row, kind: "reading", sourceId: "persisted-reading" });
        if (m) this.readings.set(m.accountId, { accountId: m.accountId, label: /^G[1-8]$/.test(row.label) ? row.label : `G${this.readings.size + 1}`,
          current: m.current!, weekly: m.weekly || null, observedAt: m.observedAt!, sourceUpdated: m.sourceUpdated || "" });
      }
    } catch { /* 无缓存或坏缓存都等真实采集器再报，不伪造读数 */ }
  }
  ingest(input: unknown, now = Date.now()): boolean {
    const m = normalizeMessage(input, now);
    if (!m) return false;
    this.expire(now);
    if (m.kind === "bye") {
      if (this.sources.get(m.sourceId)?.accountId === m.accountId) this.sources.delete(m.sourceId);
      return true;
    }
    if (!this.readings.has(m.accountId) && this.readings.size >= 8 || !this.sources.has(m.sourceId) && this.sources.size >= 64) return false;
    this.sources.set(m.sourceId, { accountId: m.accountId, at: now, monitor: m.monitor === true });
    const old = this.readings.get(m.accountId);
    if (!old || m.observedAt! >= old.observedAt) {
      const changed = !old || m.observedAt !== old.observedAt || JSON.stringify(m.current) !== JSON.stringify(old.current) || JSON.stringify(m.weekly) !== JSON.stringify(old.weekly);
      this.readings.set(m.accountId, { accountId: m.accountId, label: old?.label || `G${this.readings.size + 1}`, current: m.current!,
        weekly: m.weekly || null, observedAt: m.observedAt!, sourceUpdated: m.sourceUpdated || "" });
      if (changed && this.file) writeJsonAtomic(this.file, [...this.readings.values()]);
    }
    return true;
  }
  snapshot(now = Date.now()): QuotaRow[] {
    this.expire(now);
    const active = new Set([...this.sources.values()].filter(s => !s.monitor).map(s => s.accountId));
    return [...this.readings.values()].filter(r => active.has(r.accountId)).map(r => ({ ...r, stale: now - r.observedAt >= STALE_AFTER }));
  }
  private expire(now: number): void {
    for (const [id, source] of this.sources) if (now - source.at >= SOURCE_TTL) this.sources.delete(id);
  }
}
