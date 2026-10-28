// 一条一份小文件（2026-10-15 设定24，看板 Claude 01）：看板上每条都在数据夹里有一份单独的 md，
// 点条目左边的号码就复制它的完整路径，贴给 AI，它只读这一份——渐进式披露，不用整组翻、不用搜。
// 这份只是副本：看板数据还在 bookmarks.json，改条目照旧走看板和命令行；条目删了（干完、审过、手删）副本跟着删。
// 有打勾清单的（2026-10-28）分两份：`<id>.md` 是清单（给 AI 干活用，照数据现生成）、`<id>（原话）.md` 收着原话（出问题才翻）。
// 另放派活单的「只许动」解析和撞文件检查（一键启动前查），都是纯函数，单测直接测。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../shared/log";
import type { BookmarkRecord } from "./store";
import { checklistProgress, formatChecklist } from "./checklist";

const log = createLogger("bookmark");

/** 副本夹名：放在看板数据夹里。 */
export const ITEM_FILES_DIR = "条目（一条一份）";

export function itemFilePath(dir: string, id: string): string {
  return join(dir, `${id}.md`);
}

/** 「原话」那份的后缀：有打勾清单的条目才有这份。 */
export const ORIGINAL_SUFFIX = "（原话）";

export function itemOriginalPath(dir: string, id: string): string {
  return join(dir, `${id}${ORIGINAL_SUFFIX}.md`);
}

/** 一条要写哪几份：main 永远有；有清单才有 original。 */
export interface ItemFiles {
  main: string;
  original?: string;
}

const KIND_LABEL: Record<BookmarkRecord["kind"], string> = { note: "普通条目", handoff: "交接单", dispatch: "派活单" };

/** 一条的副本。title＝AI 写的小标题（没有就不写）；images 把贴图标记换成完整路径（imagesForAgent）。
 *  没清单：一份，原文、详情、进度全在里面。有清单：main 只放清单和最近几句进度，原文详情挪进 original。 */
export function formatItemFiles(
  record: BookmarkRecord,
  opts: { group: string; title?: string | null; project?: string | null; images?: (text: string) => string },
): ItemFiles {
  const nl = String.fromCharCode(10);
  const fix = opts.images ?? ((t: string) => t);
  const title = opts.title || firstLine(record.text);
  const status = record.claimedBy ? `${record.claimedBy} 在干` : record.report ? `${record.reportedBy ?? "AI"} 干完了，等审` : "没人领";
  const lines = [
    `# ${title}`,
    "",
    `> 看板「${opts.group}」组的一条${KIND_LABEL[record.kind]} · id ${record.id} · ${status}`,
    "> 这是看板自动写的副本：只读这一份就够，别去翻整组。要改内容、领活、交报告，照旧走看板命令（bookmark-cli.mjs），别改这个文件——改了也会被盖掉。",
  ];
  // 项目名（看板读条目时认出来的）：状态栏进度那行打头用它，比整句小标题短
  if (opts.project && opts.project !== "认不出") lines.push(`> 项目：${opts.project}`);
  if (record.forSystem) lines.push(`> 交给 ${record.forSystem}：这张是写给「${record.forSystem}」那套 Windows 的，不是那套就别接。`);
  if (record.kind === "dispatch") {
    lines.push("> 派活单：强模型拆好的活，同一批的几张会被一键同时开出去。只动单子里「只许动」写的文件；干完 report 交报告，等调度审、用户测，别自己 done。");
  }
  const original = [`## 原文`, "", fix(record.text)];
  if (record.url) original.push("", `链接：${record.url}`);
  if (record.detail) original.push("", "## 详情", "", fix(record.detail));
  const progress = record.progress?.length ? ["", "## 进度（最近几句）", "", ...record.progress.slice(-5).map((p) => `- ${p}`)] : [];
  if (!record.checklist?.length) {
    lines.push("", ...original, ...progress);
    if (record.report) lines.push("", `## 报告（${record.reportedBy ?? "AI"}）`, "", record.report);
    return { main: lines.join(nl) + nl };
  }
  const { done, total } = checklistProgress(record.checklist);
  lines.push(
    `> 打勾清单：看板照数据现生成，别手改。干完一项敲 \`看板 勾 ${record.id} <项号>\`（再敲一次取消），怎么干照领活时吐的规矩。原话收在同夹 \`${record.id}${ORIGINAL_SUFFIX}.md\`，平时不用读，清单对不上、出了问题才翻。`,
    "",
    `## 打勾清单（${done}/${total}）`,
    "",
    formatChecklist(record.checklist),
    ...progress,
  );
  if (record.report) lines.push("", `## 报告（${record.reportedBy ?? "AI"}）`, "", record.report);
  const head = [`# ${title}（原话）`, "", `> 看板「${opts.group}」组 · id ${record.id} 的原话：整理清单前的原样，收着备查。干活看同夹 \`${record.id}.md\` 的打勾清单。`, ""];
  return { main: lines.join(nl) + nl, original: [...head, ...original].join(nl) + nl };
}

/** 只要主文件那一份（老调用、单测用）。 */
export function formatItemFile(
  record: BookmarkRecord,
  opts: { group: string; title?: string | null; project?: string | null; images?: (text: string) => string },
): string {
  return formatItemFiles(record, opts).main;
}

function firstLine(text: string): string {
  const flat = text.replace(/\[图片:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat || "（只有图）";
}

/**
 * 把副本夹跟看板对齐：内容变了才写，看板上没了的删掉。只碰 `<id>.md` 和 `<id>（原话）.md`，夹里别的文件不动。
 * cache 记着上次写的内容（按文件名，同一进程里省得每次读盘比较）。出任何错只记日志，不拦看板。
 */
export function syncItemFiles(
  dir: string,
  records: BookmarkRecord[],
  render: (record: BookmarkRecord) => string | ItemFiles,
  cache: Map<string, string>,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const alive = new Set<string>();
    const write = (name: string, text: string) => {
      alive.add(name);
      const path = join(dir, name);
      if (cache.get(name) === text && existsSync(path)) return;
      if (!cache.has(name) && existsSync(path) && readFileSync(path, "utf8") === text) {
        cache.set(name, text);
        return;
      }
      writeFileSync(`${path}.tmp`, text, "utf8");
      renameSync(`${path}.tmp`, path);
      cache.set(name, text);
    };
    for (const record of records) {
      const out = render(record);
      const files = typeof out === "string" ? { main: out } : out;
      write(`${record.id}.md`, files.main);
      if (files.original != null) write(`${record.id}${ORIGINAL_SUFFIX}.md`, files.original);
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || alive.has(name)) continue;
      rmSync(join(dir, name), { force: true });
      cache.delete(name);
    }
  } catch (error) {
    log.出事("一条一份小文件同步失败（看板数据不受影响）", error, "item-files");
  }
}

// ── 派活单撞文件检查（设定23：一键启动前，两张单子写了同一份文件就不开） ──

/** 从单子里找「只许动：a；b」那一行，拆成文件清单。没写这一行返回 null；写了「无」返回 []。 */
export function parseAllowedFiles(text: string): string[] | null {
  const line = text.split(/\r?\n/).find((l) => /^\s*[-*]?\s*只许动\s*[:：]/.test(l));
  if (line == null) return null;
  const rest = line.replace(/^\s*[-*]?\s*只许动\s*[:：]/, "").trim();
  if (!rest || /^(无|没有|不改文件)/.test(rest)) return [];
  return splitOutsideBrackets(rest)
    .map((s) =>
      s
        .trim()
        .replace(/[。．]+$/, "")
        // 「夹/（仅 jsonl、报告.md）」这种跟在斜杠或空格后面的括号是备注，不是路径；夹名自带的「app（本体）」不动
        .replace(/(^|[\/\\\s])[（(][^（）()]*[）)]$/, "$1")
        .trim()
        .replace(/^[`「『"']+|[`」』"']+$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

/** 按「；;，,、」切，括号里的不切（括号里多半是备注，切开会切出「stderr」这种光秃秃的名字，两张单子一比就误判撞车）。 */
function splitOutsideBrackets(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("（(「『".includes(ch)) depth++;
    else if ("）)」』".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && "；;，,、".includes(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 两个路径算不算撞：一样，或者一个是另一个所在的夹。 */
function overlaps(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export interface FileConflict {
  a: string;
  b: string;
  files: string[];
}

/** 这几张单子之间撞了哪些文件。cards 的 name 用来报给用户（「Pi Agent 03」这种）。 */
export function findFileConflicts(cards: { name: string; files: string[] }[]): FileConflict[] {
  const out: FileConflict[] = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const hit = new Set<string>();
      for (const f of cards[i].files) for (const g of cards[j].files) if (overlaps(f, g)) hit.add(f.length <= g.length ? f : g);
      if (hit.size) out.push({ a: cards[i].name, b: cards[j].name, files: [...hit] });
    }
  }
  return out;
}
