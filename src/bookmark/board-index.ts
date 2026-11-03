// 看板号码的账（2026-10-13 用户：我说「第 9 条」「捆2」，AI 那边就知道是哪条，只读点名的，别的一概不看——省读字的钱）。
// 🚨 数法跟看板界面一模一样（renderer/bookmark.js 的 bmRenderBoard 算起点 + bmFillTaskList）：
//    全板统一编号（2026-10-15 用户：一个号只有一条）：各组照组名单顺序 → 交接单专区 → 待定区，条目号从 1 一路往下接；
//    捆号按捆头出现的先后同样全板接着数。改一边另一边也要改，不然 AI 读到的跟屏幕上对不上。
//    号码只是给人和 AI 说话用的，跟着位置变；程序里认条目一律用 id（小文件名也是 id），挪位置不用改任何文件。
// 纯函数：数据由 cli-server 的 /view 端点喂进来，读图片标注的那一下由调用方注入（测试不碰磁盘）。

import type { CliRecord } from "./cli-server";
import { idleDays, lastActiveAt, sayDuration, STALE_CLAIM_MS } from "./handoff-hygiene";

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
  /** 条目 id → 它那份「一条一份」小文件的完整路径（设定24）；没接就不写这一行。 */
  itemFile?: (id: string) => string;
}

/** 条目类型在列表里的小尾巴：交接单专区里的交接单不用再说一遍。 */
function kindTag(r: CliRecord, group: string): string {
  if (r.kind === "dispatch") return "（派活单）";
  return r.kind === "handoff" && group !== HANDOFF_GROUP ? "（交接单）" : "";
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
  // 挂起的交接单沉到专区最底下（2026-11-03）。🚨 renderer bmGroupRecords 同一个排法
  const zone = buckets.get(HANDOFF_GROUP)!;
  buckets.set(HANDOFF_GROUP, [...zone.filter((r) => !r.hold), ...zone.filter((r) => r.hold)]);
  let no = 0;
  let bundleNo = 0;
  return [...buckets].map(([name, list]) => {
    const rows = list.map((record, i) => {
      if (record.bundleId && record.bundleId !== list[i - 1]?.bundleId) bundleNo += 1;
      no += 1;
      return { no, bundleNo: record.bundleId ? bundleNo : null, record };
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
  if (!items.length && !bundles.length) throw new Error("要说看第几条或第几捆：show 7 / show 7-9 / show 捆2");
  return { items: [...new Set(items)], bundles: [...new Set(bundles)] };
}

function plain(text: string): string {
  return text.replace(/\[图片:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

function rowTitle(r: CliRecord, names: BoardNames): string {
  const mark = r.forSystem ? `【给${r.forSystem}】` : ""; // 交给哪套系统（2026-10-27）：AI 扫标题就分得清
  const t = names.titles[r.id];
  if (t) return mark + t;
  const own = plain(r.text);
  return mark + (own.length > 80 ? `${own.slice(0, 80)}…` : own || "（只有图）");
}

function rowStatus(r: CliRecord, now = Date.now()): string {
  if (r.hold) return `⏸ 挂起（${r.hold.why}）`;
  if (r.claimedBy) {
    const quiet = now - lastActiveAt(r);
    // 掉线接手（2026-11-03）：一小时没碰过这张，多半窗口关了；真接走时 next 还会再看会话记录
    if (r.claimedBy !== "已交出" && quiet >= STALE_CLAIM_MS) return `♻️ ${r.claimedBy} 在干（${sayDuration(quiet)}没碰过，可能掉线了：next 它就接走）`;
    return `♻️ ${r.claimedBy} 在干`;
  }
  if (r.report) return "✅ 干完待审";
  const idle = idleDays(r, now);
  if (idle) return `🕸 ${idle} 天没人碰`;
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
  const out: string[] = ["（只列了标题。号码全板统一，要看哪条的全文：show 7 ／ 7-9 ／ 7,8,9 ／ 捆2）"];
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
      const kind = kindTag(r, g.name);
      out.push(`${r.bundleId ? "  " : ""}${pad(row.no)} ${kind}${rowTitle(r, names)}${status ? `  ${status}` : ""}`);
    }
  }
  return out.join("\n");
}

/** 点名读全文（show）：只吐点到的那几条——原文、图（换成路径和标注清单）、链接、详情、报告，外加删改要用的 id。 */
export function formatShow(groups: BoardGroup[], names: BoardNames, groupName: string, spec: ShowSpec, expandImages: (text: string) => string): string {
  // 号码全板统一（2026-10-15）：不写组名就全板找；写了组名照样全板找，只是不在那组时提一句，免得用户说错组就读不到
  const said = groupName.trim() ? findGroup(groups, groupName) : null;
  if (groupName.trim() && !said) throw new Error(`没有叫「${groupName}」的组。有：${groups.map((x) => x.name).join("、")}`);
  const all = groups.flatMap((g) => g.rows.map((row) => ({ g, row })));
  const total = all.length;
  const out: string[] = ["（号码跟着看板变：先对一下标题是不是用户说的那件事，对不上就停下问他。）"];
  const missing: string[] = [];
  const shown = new Set<string>();
  const bundleCount = new Set(all.map((x) => x.row.bundleNo).filter((n) => n !== null)).size;
  const note = (g: BoardGroup) => (said && said !== g ? [`（这条在「${g.name}」组，不在「${said.name}」组）`] : []);
  for (const b of spec.bundles) {
    const hits = all.filter((x) => x.row.bundleNo === b);
    if (!hits.length) {
      missing.push(`捆${b}（全板一共 ${bundleCount} 捆）`);
      continue;
    }
    const g = hits[0].g;
    // 末尾带捆号：命令行 `next 捆2` 靠它换成捆号（2026-10-29 接活自动标）
    out.push("", `【捆${b} · ${g.name} 组】${bundleName(g.rows, hits[0].row.record.bundleId!, names)}（${hits.length} 条：${hits.map((x) => pad(x.row.no)).join(" ")}）· 捆号 ${hits[0].row.record.bundleId}`, ...note(g));
    for (const { row } of hits) {
      if (shown.has(row.record.id)) continue;
      shown.add(row.record.id);
      out.push(...showRow(g, row, names, expandImages), "");
    }
  }
  for (const n of spec.items) {
    const hit = all.find((x) => x.row.no === n);
    if (!hit) {
      missing.push(`第 ${n} 条（全板一共 ${total} 条）`);
      continue;
    }
    if (shown.has(hit.row.record.id)) continue;
    shown.add(hit.row.record.id);
    out.push("", ...showRow(hit.g, hit.row, names, expandImages), ...note(hit.g));
  }
  if (missing.length) out.push("", `看板上没有：${missing.join("、")}`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function showRow(g: BoardGroup, row: BoardRow, names: BoardNames, expandImages: (text: string) => string): string[] {
  const r = row.record;
  const where = row.bundleNo ? ` · 捆${row.bundleNo}` : "";
  const lines = [`━━ 第 ${pad(row.no)} 条 · ${g.name} 组${where}${r.kind === "handoff" ? " · 交接单" : r.kind === "dispatch" ? " · 派活单" : ""} · id ${r.id}`, `标题：${rowTitle(r, names)}`];
  if (names.itemFile) {
    try {
      lines.push(`单独文件：${names.itemFile(r.id)}`);
    } catch {
      /* 小文件还没写出来就不报这一行 */
    }
  }
  const status = rowStatus(r);
  if (status) lines.push(`状态：${status}`);
  lines.push("原文：", expandImages(r.text).trim());
  if (r.url) lines.push(`链接：${r.url}`);
  if (r.detail) lines.push("详情：", r.detail.trim());
  if (r.report) lines.push("报告：", r.report.trim());
  return lines;
}
