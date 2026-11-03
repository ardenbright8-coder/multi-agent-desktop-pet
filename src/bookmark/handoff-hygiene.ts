// 交接单收尾的几把尺子（2026-11-03 用户：交接单堆成一堆、不会自己消失；先把洞补上，再拿老单子一张张当考题）。
// 问题账：书签工具 `维修（排障）\03～07`；设定：设计思路 26「交接单自己收尾」。
// 纯函数，不碰磁盘：store 和界面、命令行都拿这里的数，改阈值只改这一处。

/** 掉线接手：领着单子的窗口这么久没动静，别的窗口 next 它就直接接走（原窗口最后说的话记进进度）。 */
export const STALE_CLAIM_MS = 60 * 60_000;
/** 久没动：交接单这么多天没人碰，看板标灰、list 单列出来，等他点删。程序一张都不删。 */
export const STALE_DAYS = 7;
/** 写新交接单时，跟已有交接单的标题像到这个分数（0～1）就拦下，叫 AI 往旧单上记。
 *  2026-11-03 拿真单子试的：「燊一修跑关系网更新」三张两两 0.64 / 0.30 / 0.29，不相干的都在 0.25 以下；
 *  拦错了 AI 加 --new 照样写，漏拦就又多一张，所以宁低勿高。 */
export const SIMILAR_TITLE = 0.28;

/** 挂起（等他说做再做）：谁挂的、为啥、什么时候。挂起的不参加久没动、领活按组时跳过。 */
export interface HoldMark {
  at: string;
  by: string;
  why: string;
}

/** 算动静要看的几个字段（store 的记录和命令行拿到的记录都有）。 */
export interface ActivityFields {
  kind?: string;
  createdAt: string;
  claimedAt?: string | null;
  touchedAt?: string | null;
  claimedBy?: string | null;
  report?: string | null;
  hold?: HoldMark | null;
}

function time(value: string | null | undefined): number {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : 0;
}

/** 这张单子最后一次有人碰是什么时候（毫秒）：建单、领走、窗口用看板命令碰它，取最晚的。 */
export function lastActiveAt(r: ActivityFields): number {
  return Math.max(time(r.createdAt), time(r.claimedAt), time(r.touchedAt));
}

/** 久没动几天（不是交接单、挂起的、交过报告的都算 0）。 */
export function idleDays(r: ActivityFields, now = Date.now()): number {
  if (r.kind !== "handoff" || r.hold || r.report) return 0;
  const days = Math.floor((now - lastActiveAt(r)) / 86_400_000);
  return days >= STALE_DAYS ? days : 0;
}

/** 「1 小时 20 分」这种说法，给进度和报错用。 */
export function sayDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} 小时${min % 60 ? ` ${min % 60} 分` : ""}`;
  return `${Math.floor(h / 24)} 天`;
}

/** 标题去掉不算数的：【给X】名牌、标点、空白、常见套话。 */
function core(title: string): string {
  return String(title ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/\[图片:[^\]]*\]/g, "")
    .replace(/接着干|接手|先问|交接单?|看板/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function pairs(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/** 两个标题像不像（0～1）：去掉套话后按相邻两字算重合度。 */
export function titleSimilarity(a: string, b: string): number {
  const x = pairs(core(a));
  const y = pairs(core(b));
  if (!x.size || !y.size) return 0;
  let same = 0;
  for (const p of x) if (y.has(p)) same += 1;
  return (2 * same) / (x.size + y.size);
}

/** 专区里跟新标题像的那几张，最像的在前。只比交接单，挂起的也比（挂起的同一件事更该往旧单上记）。 */
export function similarHandoffs<T extends { id: string; text: string; kind?: string }>(title: string, records: T[], min = SIMILAR_TITLE): { record: T; score: number }[] {
  return records
    .filter((r) => r.kind === "handoff")
    .map((record) => ({ record, score: titleSimilarity(title, record.text) }))
    .filter((x) => x.score >= min)
    .sort((p, q) => q.score - p.score);
}
