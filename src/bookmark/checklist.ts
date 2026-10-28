// 打勾清单（2026-10-28 用户：单子越堆越多、干完了没人删；AI 只拨开关，状态栏联动显示，全勾完单子自己没了）。
// 一张单子一份两层清单：一件事 → 下挂小项（按包含关系分，不分大事小事）。小项全勾完，上一层自动算完。
// 干活的 AI 读原话整理好、跟用户对齐后用「清单」命令交进来；以后只「勾」，清单文件由程序照数据现生成，AI 不手改。
// 这里全是纯函数：解析 AI 交的清单、拨开关、算进度、排成文字。存盘和自动收单在 store。

export interface ChecklistItem {
  /** 编号：上一层 1、2、3，小项 1.1、1.2。由结构现排，不认 AI 手写的号。 */
  no: string;
  text: string;
  done: boolean;
  /** 谁勾的（窗口名；用户在看板上点的是「用户」）。没勾是 null。 */
  by: string | null;
  /** 几点勾的（ISO 时间）。没勾是 null。 */
  at: string | null;
}

/** 一张单子最多几项、每项最长几个字：清单是拿来勾的，不是写文章。 */
export const MAX_CHECKLIST_ITEMS = 60;
export const MAX_CHECKLIST_TEXT = 200;

const LINE = /^(\s*)[-*+]\s+\[( |x|X|✓|✔)\]\s*(.*)$/;
const NUMBER = /^(\d+)(?:[.．、](\d+))?[.．、)）]?\s+/;

/** 解析 AI 交的清单（GitHub 写法）：`- [ ] 1 内容`、缩进的 `  - [ ] 1.1 内容`。
 *  哪一层看编号（写了 1.1 就是小项），没写编号看缩进（缩两格以上算小项）；编号一律按结构重排。
 *  不是打勾行的（标题、空行、说明）跳过。一行都没有、超长、小项前面没有上一层，都抛错（错话给 AI 看）。 */
export function parseChecklist(md: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  let top = 0;
  let sub = 0;
  for (const raw of String(md ?? "").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "  ").length;
    let text = m[3].trim();
    const num = NUMBER.exec(text);
    const child = num ? num[2] != null : indent >= 2;
    if (num) text = text.slice(num[0].length).trim();
    text = text.replace(/\s+/g, " ");
    if (!text) continue;
    if (text.length > MAX_CHECKLIST_TEXT) throw new Error(`第 ${out.length + 1} 项太长了（${text.length} 字，最多 ${MAX_CHECKLIST_TEXT}）：清单一项一句话，细节留在原话里`);
    const done = m[2] !== " ";
    if (child) {
      if (!top) throw new Error(`「${text.slice(0, 20)}」是小项，但前面没有上一层的那件事：先写 - [ ] 1 那件事，再缩进写小项`);
      sub += 1;
      out.push({ no: `${top}.${sub}`, text, done, by: null, at: null });
    } else {
      top += 1;
      sub = 0;
      out.push({ no: String(top), text, done, by: null, at: null });
    }
  }
  if (!out.length) throw new Error("清单里一项都没有：一行一项，写成 - [ ] 1 那件事 ／ 缩进两格 - [ ] 1.1 小项");
  if (out.length > MAX_CHECKLIST_ITEMS) throw new Error(`清单 ${out.length} 项太多了（最多 ${MAX_CHECKLIST_ITEMS}）：按包含关系并一并`);
  return settle(out);
}

/** 读存档里的清单：坏的项丢掉，不拦看板。 */
export function normalizeChecklist(raw: unknown): ChecklistItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .filter((x) => typeof x.no === "string" && /^\d+(\.\d+)?$/.test(x.no) && typeof x.text === "string" && x.text.trim())
    .map((x) => ({
      no: String(x.no),
      text: String(x.text),
      done: x.done === true,
      by: typeof x.by === "string" ? x.by : null,
      at: typeof x.at === "string" ? x.at : null,
    }));
  return items.length ? items : undefined;
}

const isChild = (no: string) => no.includes(".");
const parentOf = (no: string) => no.split(".")[0];
const childrenOf = (items: ChecklistItem[], no: string) => items.filter((x) => isChild(x.no) && parentOf(x.no) === no);

/** 上一层跟着小项走：有小项的，小项全勾完它才算完（谁勾的、几点算最后勾的那一下）。 */
function settle(items: ChecklistItem[]): ChecklistItem[] {
  for (const top of items.filter((x) => !isChild(x.no))) {
    const kids = childrenOf(items, top.no);
    if (!kids.length) continue;
    const all = kids.every((k) => k.done);
    if (all && !top.done) {
      const last = [...kids].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? ""))).pop()!;
      top.done = true;
      top.by = last.by;
      top.at = last.at;
    } else if (!all && top.done) {
      top.done = false;
      top.by = null;
      top.at = null;
    }
  }
  return items;
}

/** 拨开关：没勾的勾上、勾了的取消。勾上一层＝它下面的小项一起勾（中途改了主意、这件事目的已达到，直接勾掉）。
 *  返回新的一份，不改传进来的。编号对不上抛错，错话里列出有哪些号。 */
export function toggleItem(items: ChecklistItem[], no: string, by: string, at: string): ChecklistItem[] {
  const key = String(no ?? "").trim().replace(/[．、]/g, ".").replace(/\.$/, "");
  const next = items.map((x) => ({ ...x }));
  const hit = next.find((x) => x.no === key);
  if (!hit) throw new Error(`清单里没有 ${key || "（空）"} 这一项，有的是：${items.map((x) => x.no).join(" ")}`);
  const turnOn = !hit.done;
  const set = (x: ChecklistItem) => {
    x.done = turnOn;
    x.by = turnOn ? by : null;
    x.at = turnOn ? at : null;
  };
  set(hit);
  if (!isChild(hit.no)) for (const kid of childrenOf(next, hit.no)) set(kid);
  return settle(next);
}

/** 进度按上一层数（状态栏、看板上显示的 2/4）。 */
export function checklistProgress(items: ChecklistItem[] | undefined): { done: number; total: number } {
  const tops = (items ?? []).filter((x) => !isChild(x.no));
  return { done: tops.filter((x) => x.done).length, total: tops.length };
}

export function checklistAllDone(items: ChecklistItem[] | undefined): boolean {
  const p = checklistProgress(items);
  return p.total > 0 && p.done === p.total;
}

function stamp(at: string | null): string {
  const t = at ? new Date(at) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  return `${t.getMonth() + 1}-${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** 整份清单排成 md（给「清单」副本文件）：勾了的后面带谁勾的、几点。 */
export function formatChecklist(items: ChecklistItem[]): string {
  return items
    .map((x) => {
      const who = x.done && x.by ? `（${x.by} ${stamp(x.at)} 勾）` : "";
      return `${isChild(x.no) ? "  " : ""}- [${x.done ? "x" : " "}] ${x.no} ${x.text}${who}`;
    })
    .join("\n");
}

/** 最后一句进度：先看进度栏，老单子写进详情的【进度 …】也认。 */
export function lastProgress(record: { progress?: string[]; detail: string | null }): string | null {
  if (record.progress?.length) return record.progress[record.progress.length - 1];
  const lines = (record.detail ?? "").split(/\r?\n/).filter((l) => l.startsWith("【进度 "));
  return lines.length ? lines[lines.length - 1].replace(/^【进度 ([^】]+)】/, "$1 ") : null;
}

/** 只排没勾的（给领活那段话，省字）：上一层没勾完的带着它没勾的小项。全勾完返回空串。 */
export function formatPending(items: ChecklistItem[]): string {
  const lines: string[] = [];
  for (const top of items.filter((x) => !isChild(x.no))) {
    if (top.done) continue;
    lines.push(`- [ ] ${top.no} ${top.text}`);
    for (const kid of childrenOf(items, top.no)) if (!kid.done) lines.push(`  - [ ] ${kid.no} ${kid.text}`);
  }
  return lines.join("\n");
}
