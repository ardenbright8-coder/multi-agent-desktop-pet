// 纯数据层：同账号多来源合并；只保存读数，不保存邮箱、cookie或聊天正文。
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "../shared/atomic-file";

export const SOURCE_TTL = 38_000;
export const STALE_AFTER = 12 * 60_000;
export interface QuotaValue { used: number; reset: { raw: string; epoch: number | null } }
export interface QuotaMessage {
  kind: "reading" | "bye"; accountId: string; sourceId: string; monitor?: boolean;
  current?: QuotaValue; weekly?: QuotaValue | null; observedAt?: number; sourceUpdated?: string;
  accountTag?: string; plan?: string; focused?: boolean;
}
export interface QuotaRow {
  accountId: string; label: string; current: QuotaValue; weekly: QuotaValue | null;
  observedAt: number; sourceUpdated: string; stale: boolean;
  accountTag?: string; plan?: string; activeAt?: number; lastSeenAt?: number; closed?: boolean;
}
type Saved = Omit<QuotaRow, "stale">;
function value(input: unknown): QuotaValue | null {
  const v = input as QuotaValue;
  if (!v || !Number.isFinite(v.used) || v.used < 0 || v.used > 100 || !v.reset
    || typeof v.reset.raw !== "string" || v.reset.raw.length > 96
    || !(v.reset.epoch === null || Number.isFinite(v.reset.epoch))) return null;
  return { used: v.used, reset: { raw: v.reset.raw, epoch: v.reset.epoch } };
}
function cleanText(input: unknown, maxLen: number): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.replace(/@/g, "").trim().slice(0, maxLen);
  return s || undefined;
}
export function normalizeMessage(input: unknown, now = Date.now()): QuotaMessage | null {
  if (!input || typeof input !== "object") return null;
  const m = input as QuotaMessage;
  if (!/^[a-f0-9]{8,64}$/.test(m.accountId || "") || !/^[a-zA-Z0-9-]{8,80}$/.test(m.sourceId || "")) return null;
  if (m.kind === "bye") return { kind: "bye", accountId: m.accountId, sourceId: m.sourceId };
  const current = value(m.current), weekly = m.weekly == null ? null : value(m.weekly);
  if (m.kind !== "reading" || !current || m.weekly != null && !weekly || !Number.isFinite(m.observedAt)
    || m.observedAt! > now + 120_000 || now - m.observedAt! > 24 * 3600_000) return null;
  const accountTag = cleanText(m.accountTag, 24), plan = cleanText(m.plan, 32);
  return { kind: "reading", accountId: m.accountId, sourceId: m.sourceId, monitor: m.monitor === true, current, weekly,
    observedAt: m.observedAt, sourceUpdated: typeof m.sourceUpdated === "string" ? m.sourceUpdated.slice(0, 96) : "",
    ...(accountTag ? { accountTag } : {}), ...(plan ? { plan } : {}), ...(m.focused === true ? { focused: true } : {}) };
}
export class QuotaStore {
  private readings = new Map<string, Saved>();
  private sources = new Map<string, { accountId: string; at: number; monitor: boolean }>();
  private startedAt = Date.now();
  constructor(private file?: string) {
    if (!file) return;
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as Saved[];
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(0, 8)) {
        const m = normalizeMessage({ ...row, kind: "reading", sourceId: "persisted-reading" });
        if (m) this.readings.set(m.accountId, { accountId: m.accountId, label: /^G[1-8]$/.test(row.label) ? row.label : `G${this.readings.size + 1}`,
          current: m.current!, weekly: m.weekly || null, observedAt: m.observedAt!, sourceUpdated: m.sourceUpdated || "",
          ...(m.accountTag ? { accountTag: m.accountTag } : {}), ...(m.plan ? { plan: m.plan } : {}),
          ...(Number.isFinite(row.activeAt) ? { activeAt: row.activeAt } : {}),
          ...(Number.isFinite(row.lastSeenAt) ? { lastSeenAt: row.lastSeenAt } : {}),
          ...(typeof row.closed === "boolean" ? { closed: row.closed } : {}) });
      }
    } catch { /* 无缓存或坏缓存都等真实采集器再报，不伪造读数 */ }
  }
  ingest(input: unknown, now = Date.now()): boolean {
    const m = normalizeMessage(input, now);
    if (!m) return false;
    this.expire(now);
    if (m.kind === "bye") {
      if (this.sources.get(m.sourceId)?.accountId === m.accountId) this.sources.delete(m.sourceId);
      const stillOpen = [...this.sources.values()].some(s => s.accountId === m.accountId && !s.monitor);
      const row = this.readings.get(m.accountId);
      if (row && !stillOpen) {
        this.readings.set(m.accountId, { ...row, closed: true });
        if (this.file) writeJsonAtomic(this.file, [...this.readings.values()]);
      }
      return true;
    }
    if (!this.readings.has(m.accountId) && this.readings.size >= 8 || !this.sources.has(m.sourceId) && this.sources.size >= 64) return false;
    this.sources.set(m.sourceId, { accountId: m.accountId, at: now, monitor: m.monitor === true });
    const old = this.readings.get(m.accountId);
    const accountTag = m.accountTag || old?.accountTag;
    const plan = m.plan || old?.plan;
    const activeAt = m.focused ? now : old?.activeAt;
    const hasActiveChat = [...this.sources.values()].some(s => s.accountId === m.accountId && !s.monitor);
    const lastSeenAt = !m.monitor ? now : old?.lastSeenAt;
    const closed = !hasActiveChat;
    const isHeartbeatOnly = Boolean(old && m.current?.reset.raw === "--" && old.current.reset.raw !== "--");
    if (!isHeartbeatOnly && (!old || m.observedAt! >= old.observedAt)) {
      this.readings.set(m.accountId, { accountId: m.accountId, label: old?.label || `G${this.readings.size + 1}`, current: m.current!,
        weekly: m.weekly || null, observedAt: m.observedAt!, sourceUpdated: m.sourceUpdated || "",
        ...(accountTag ? { accountTag } : {}), ...(plan ? { plan } : {}), ...(activeAt ? { activeAt } : {}), ...(lastSeenAt ? { lastSeenAt } : {}), closed });
      if (this.file) writeJsonAtomic(this.file, [...this.readings.values()]);
    } else if (old && (!m.monitor || Boolean(old.closed) !== closed)) {
      this.readings.set(m.accountId, { ...old, ...(accountTag ? { accountTag } : {}), ...(plan ? { plan } : {}), ...(activeAt ? { activeAt } : {}), ...(lastSeenAt ? { lastSeenAt } : {}), closed });
      if (this.file) writeJsonAtomic(this.file, [...this.readings.values()]);
    }
    return true;
  }
  snapshot(now = Date.now()): QuotaRow[] {
    this.expire(now);
    const active = new Set([...this.sources.values()].filter(s => !s.monitor).map(s => s.accountId));
    if (now - this.startedAt >= 10_000) {
      let statusChanged = false;
      for (const [id, r] of this.readings) {
        const shouldClose = !active.has(id);
        if (Boolean(r.closed) !== shouldClose) {
          this.readings.set(id, { ...r, closed: shouldClose });
          statusChanged = true;
        }
      }
      if (statusChanged && this.file) writeJsonAtomic(this.file, [...this.readings.values()]);
    }
    return [...this.readings.values()].filter(r => active.has(r.accountId)).map(r => ({ ...r, stale: now - r.observedAt >= STALE_AFTER }));
  }
  private expire(now: number): void {
    for (const [id, source] of this.sources) if (now - source.at >= SOURCE_TTL) this.sources.delete(id);
  }
}
