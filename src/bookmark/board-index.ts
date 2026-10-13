// 看板号码的账（2026-10-13 用户：我说「Claude 第 9 条」「Claude 捆2」，AI 那边就知道是哪条，只读点名的，别的一概不看——省读字的钱）。
// 🚨 数法跟看板界面一模一样（renderer/bookmark.js 的 bmGroupRecords + bmFillTaskList）：
//    条目号＝同组按看板从上往下的顺序从 1 数；捆号＝同组捆头出现的先后从 1 数。改一边另一边也要改，不然 AI 读到的跟屏幕上对不上。
// 纯函数：数据由 cli-server 的 /view 端点喂进来，读图片标注的那一下由调用方注入（测试不碰磁盘）。

import type { CliRecord } from "./cli-server";

/** 交接单专区、待定区在命令里的叫法（屏幕上看到的字）。 */
export const HANDOFF_GROUP = "交接单";
export const INBOX_GROUP = "待定";

export interface BoardRow {
  no: number;
  bundleNo: number | null;
  record: CliRecord;
}

export interface BoardGroup {
  name: string;
  rows: BoardRow[];
}

/** 算号码之外要用的：AI 写的小标题（条目 id → 标题）、捆名（捆号 → 名字）。 */
export interface BoardNames {
  titles: Record<string, string>;
  bundleNames: Record<string, string>;
}

/** 按看板的样子分组编号：各 Agent 组（照组名单顺序）→ 交接单专区 → 待定区。 */
export function indexBoard(records: CliRecord[], agents: string[]): BoardGroup[] {
  const owners = new Map(agents.map((a) => [a.toLowerCase(), a]));
  const buckets = new Map<string, CliRecord[]>();
  for (const name of [...agents, HANDOFF_GROUP, INBOX_GROUP]) buckets.set(name, []);
  for (const r of records) {
    // 派给了已删掉的组：普通条目回待定区、交接单回专区（跟看板一样）
    const owner = r.assignee ? owners.get(r.assignee.toLowerCase()) : undefined;
    buckets.get(owner ?? (r.kind === "handoff" ? HANDOFF_GROUP : INBOX_GROUP))!.push(r);
  }
  return [...buckets].map(([name, list]) => {
    let bundleNo = 0;
    const rows = list.map((record, i) => {
      if (record.bundleId && record.bundleId !== list[i - 1]?.bundleId) bundleNo += 1;
      return { no: i + 1, bundleNo: record.bundleId ? bundleNo : null, record };
    });
    return { name, rows };
  });
}

const GROUP_ALIASES: Record<string, string> = {
  交接单专区: HANDOFF_GROUP, 交接: HANDOFF_GROUP, handoff: HANDOFF_GROUP,
  待定区: INBOX_GROUP, 想想区: INBOX_GROUP, inbox: INBOX_GROUP,
};

/** 组名认法：大小写不敏感；交接单专区／待定区有别名；只写开头（Pi → Pi Agent）认得出唯一一组也算。 */
export function findGroup(groups: BoardGroup[], name: string): BoardGroup | null {
  const want = (GROUP_ALIASES[name.trim()] ?? name).trim().toLowerCase();
  if (!want) return null;
  const exact = groups.find((g) => g.name.toLowerCase() === want);
  if (exact) return exact;
  const prefix = groups.filter((g) => g.name.toLowerCase().startsWith(want));
  return prefix.length === 1 ? prefix[0] : null;
}

export interface ShowSpec {
  items: number[];
  bundles: number[];
}

/** 号码怎么写都认：7、07、7-9、7,8,9、7、8、9、捆2、捆2-3。认不出的抛错（错误话是给 AI 看的）。 */
export function parseShowSpec(tokens: string[]): ShowSpec {
  const items: number[] = [];
  const bundles: number[] = [];
  for (const piece of tokens.join(" ").split(/[\s,，、]+/).filter(Boolean)) {
    const m = /^(捆)?(\d+)(?:[-~～到](\d+))?$/.exec(piece);
    if (!m) throw new Error(`看不懂「${piece}」。号码这么写：7、7-9、7,8,9、捆2`);
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    if (from < 1 || to < from || to - from > 50) throw new Error(`「${piece}」这段号码不对`);
    for (let n = from; n <= to; n += 1) (m[1] ? bundles : items).push(n);
  }
  if (!items.length && !bundles.length) throw new Error("要说看第几条或第几捆：show Claude 7 / show Claude 7-9 / show Claude 捆2");
  return { items: [...new Set(items)], bundles: [...new Set(bundles)] };
}

function plain(text: string): string {
  return text.replace(/\[图片:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

function rowTitle(r: CliRecord, names: BoardNames): string {
  const t = names.titles[r.id];
  if (t) return t;
  const own = plain(r.text);
  return own.length > 80 ? `${own.slice(0, 80)}…` : own || "（只有图）";
}

function rowStatus(r: CliRecord): string {
  if (r.claimedBy) return `🟢 ${r.claimedBy} 在干`;
  if (r.report) return "✅ 干完待审";
  return "";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function bundleName(groupRows: BoardRow[], bundleId: string, names: BoardNames): string {
  const named = names.bundleNames[bundleId];
  if (named) return named;
  const first = groupRows.find((row) => row.record.bundleId === bundleId);
  return first ? rowTitle(first.record, names) : "";
}

/** 只列标题（list 不带 --json 时）：一条一行「号码 小标题」，捆先列一行「捆号 捆名」。不给原文、不给 id。 */
export function formatBrief(groups: BoardGroup[], names: BoardNames, only?: string): string {
  const picked = only ? [findGroup(groups, only)].filter((g): g is BoardGroup => g !== null) : groups.filter((g) => g.rows.length);
  if (only && !picked.length) return `没有叫「${only}」的组。有：${groups.map((g) => g.name).join("、")}`;
  const out: string[] = ["（只列了标题。要看哪条的全文：show <组名> 7 ／ 7-9 ／ 7,8,9 ／ 捆2）"];
  for (const g of picked) {
    out.push("", `【${g.name}】${g.rows.length} 条`);
    if (!g.rows.length) out.push("  （空的）");
    let lastBundle: string | null = null;
    for (const row of g.rows) {
      const r = row.record;
      if (r.bundleId && r.bundleId !== lastBundle) {
        const size = g.rows.filter((x) => x.record.bundleId === r.bundleId).length;
        out.push(`捆${row.bundleNo} ${bundleName(g.rows, r.bundleId, names)}（${size} 条）`);
      }
      lastBundle = r.bundleId ?? null;
      const status = rowStatus(r);
      const kind = r.kind === "handoff" && g.name !== HANDOFF_GROUP ? "（交接单）" : "";
      out.push(`${r.bundleId ? "  " : ""}${pad(row.no)} ${kind}${rowTitle(r, names)}${status ? `  ${status}` : ""}`);
    }
  }
  return out.join("\n");
}

/** 点名读全文（show）：只吐点到的那几条——原文、图（换成路径和标注清单）、链接、详情、报告，外加删改要用的 id。 */
export function formatShow(groups: BoardGroup[], names: BoardNames, groupName: string, spec: ShowSpec, expandImages: (text: string) => string): string {
  const g = findGroup(groups, groupName);
  if (!g) throw new Error(`没有叫「${groupName}」的组。有：${groups.map((x) => x.name).join("、")}`);
  const out: string[] = ["（号码跟着看板变：先对一下标题是不是用户说的那件事，对不上就停下问他。）"];
  const missing: string[] = [];
  const shown = new Set<string>();
  const bundleCount = new Set(g.rows.map((r) => r.bundleNo).filter((n) => n !== null)).size;
  for (const b of spec.bundles) {
    const rows = g.rows.filter((r) => r.bundleNo === b);
    if (!rows.length) {
      missing.push(`捆${b}（这组一共 ${bundleCount} 捆）`);
      continue;
    }
    out.push("", `【${g.name} 捆${b}】${bundleName(g.rows, rows[0].record.bundleId!, names)}（${rows.length} 条：${rows.map((r) => pad(r.no)).join(" ")}）`);
    for (const row of rows) {
      if (shown.has(row.record.id)) continue;
      shown.add(row.record.id);
      out.push(...showRow(g, row, names, expandImages), "");
    }
  }
  for (const n of spec.items) {
    const row = g.rows.find((r) => r.no === n);
    if (!row) {
      missing.push(`第 ${n} 条（这组一共 ${g.rows.length} 条）`);
      continue;
    }
    if (shown.has(row.record.id)) continue;
    shown.add(row.record.id);
    out.push("", ...showRow(g, row, names, expandImages));
  }
  if (missing.length) out.push("", `${g.name} 没有：${missing.join("、")}`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function showRow(g: BoardGroup, row: BoardRow, names: BoardNames, expandImages: (text: string) => string): string[] {
  const r = row.record;
  const where = row.bundleNo ? ` · 捆${row.bundleNo}` : "";
  const lines = [`━━ ${g.name} ${pad(row.no)}${where}${r.kind === "handoff" ? " · 交接单" : ""} · id ${r.id}`, `标题：${rowTitle(r, names)}`];
  const status = rowStatus(r);
  if (status) lines.push(`状态：${status}`);
  lines.push("原文：", expandImages(r.text).trim());
  if (r.url) lines.push(`链接：${r.url}`);
  if (r.detail) lines.push("详情：", r.detail.trim());
  if (r.report) lines.push("报告：", r.report.trim());
  return lines;
}
