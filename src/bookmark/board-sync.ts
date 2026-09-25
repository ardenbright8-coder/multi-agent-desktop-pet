// 手机同步看板（2026-09-24 设定19）：电脑把整板抄一份发到阿里云中转站的 bookmark-board 主题（电脑只写、手机只读），
// 手机打开就拉最新一份；手机上挪组、删条发回来（type=op，走收信那条路），电脑照做。
// 🚨 隔离铁律：发不出去只记日志，绝不抛给调用方、绝不连坐看板和桌宠。
// 🚨 中转站单条消息上限已调到 256K（server.yml message-size-limit），整板一份发；电脑关着时手机看的是最后一份。

import { createLogger } from "../shared/log";
import type { BoardMode } from "./sleep-mode";

const log = createLogger("bookmark");

/** 抄整板要用到的条目字段（store 的 BookmarkRecord 同形的子集）。 */
export interface BoardRow {
  id: string;
  text: string;
  url: string | null;
  assignee: string | null;
  kind: "note" | "handoff";
  detail: string | null;
  bundleId: string | null;
  claimedBy: string | null;
  report: string | null;
  reportedBy: string | null;
  reportedAt: string | null;
  dedupeKey: string | null;
  createdAt: string;
  attachments: string[];
}

/** 发给手机的一条：不带本机图片路径（图不上传中转站），只说有几张。 */
export interface BoardItem {
  id: string;
  text: string;
  assignee: string | null;
  kind: "note" | "handoff";
  detail: string | null;
  bundleId: string | null;
  claimedBy: string | null;
  report: string | null;
  reportedBy: string | null;
  reportedAt: string | null;
  /** 手机发来的条目带着它：手机靠它认出「我发的这条已经进看板了」。 */
  dedupeKey: string | null;
  url: string | null;
  images: number;
}

export interface BoardSnapshot {
  v: 1;
  type: "board";
  ts: number;
  mode: BoardMode;
  agents: string[];
  /** 看板顺序（store 数组顺序＝每组里从上到下）。 */
  items: BoardItem[];
}

export function buildBoardSnapshot(rows: BoardRow[], agents: string[], mode: BoardMode, now: number): BoardSnapshot {
  return {
    v: 1,
    type: "board",
    ts: now,
    mode,
    agents: [...agents],
    items: rows.map((r) => ({
      id: r.id,
      text: r.text,
      assignee: r.assignee,
      kind: r.kind,
      detail: r.detail,
      bundleId: r.bundleId,
      claimedBy: r.claimedBy,
      report: r.report,
      reportedBy: r.reportedBy,
      reportedAt: r.reportedAt,
      dedupeKey: r.dedupeKey,
      url: r.url,
      images: r.attachments.length,
    })),
  };
}

/** 手机发回来的命令：挪到哪个组（null＝挪回待定）/ 删掉（含早上审完「可以，删掉」）。 */
export type PhoneOp = { op: "assign"; id: string; assignee: string | null } | { op: "delete"; id: string };

/** 只认 type=op 的 assign / delete；别的（note、bookmark、task 照旧入库，cmd 只入库绝不执行）一律 null。 */
export function parsePhoneOp(raw: Record<string, unknown>): PhoneOp | null {
  if (raw.type !== "op") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  if (raw.op === "delete") return { op: "delete", id };
  if (raw.op === "assign") {
    const assignee = typeof raw.assignee === "string" && raw.assignee.trim() ? raw.assignee.trim() : null;
    return { op: "assign", id, assignee };
  }
  return null;
}

/** 照手机的命令改看板，返回一句大白话记日志。条目已经不在了不算错（手机看的可能是旧的一份）。 */
export function applyPhoneOp(
  store: { list(): { id: string; text: string }[]; setAssignee(id: string, assignee: string | null): unknown; remove(id: string): boolean },
  op: PhoneOp,
): string {
  const record = store.list().find((r) => r.id === op.id);
  if (!record) return op.op === "delete" ? "要删的那条已经不在了" : "要挪的那条已经不在了";
  const name = record.text.slice(0, 30);
  if (op.op === "delete") {
    store.remove(op.id);
    return `删掉「${name}」`;
  }
  store.setAssignee(op.id, op.assignee);
  return op.assignee ? `把「${name}」挪到 ${op.assignee}` : `把「${name}」挪回待定`;
}

// ── 发整板（IO 层）：每几秒看一眼整板变没变，变了才发；电脑开着时每 6 小时补发一份，免得手机拉的窗口里找不到 ──

export interface BoardPublisherOptions {
  server: string;
  user: string;
  pass: string;
  topic: string;
  /** 现在整板长什么样（每次看都重新算）。 */
  snapshot: () => BoardSnapshot;
  checkMs?: number;
  refreshMs?: number;
}

export function startBoardPublisher(options: BoardPublisherOptions): { stop: () => void } {
  const checkMs = options.checkMs ?? 5_000;
  const refreshMs = options.refreshMs ?? 6 * 60 * 60_000;
  let lastBody = "";
  let lastSentAt = 0;
  let sending = false;
  const tick = async () => {
    if (sending) return;
    let snap: BoardSnapshot;
    try {
      snap = options.snapshot();
    } catch (error) {
      log.出事("抄整板出错（下回再抄）", error, "board");
      return;
    }
    // 比的是去掉时间戳的内容：只有看板真变了、或者该补发了才发
    const body = JSON.stringify({ ...snap, ts: 0 });
    if (body === lastBody && Date.now() - lastSentAt < refreshMs) return;
    sending = true;
    try {
      const res = await fetch(`${options.server}/${options.topic}`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${options.user}:${options.pass}`).toString("base64") },
        body: JSON.stringify(snap),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        lastBody = body;
        lastSentAt = Date.now();
      } else log.出事(`整板发给手机失败：HTTP ${res.status}（下回再发）`, undefined, "board");
    } catch (error) {
      log.出事("整板发给手机失败（断网？下回再发）", error, "board");
    } finally {
      sending = false;
    }
  };
  const timer = setInterval(() => void tick(), checkMs);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
