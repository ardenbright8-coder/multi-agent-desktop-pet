// 一条一份小文件（2026-10-15 设定24，看板 Claude 01）：看板上每条都在数据夹里有一份单独的 md，
// 点条目左边的号码就复制它的完整路径，贴给 AI，它只读这一份——渐进式披露，不用整组翻、不用搜。
// 这份只是副本：看板数据还在 bookmarks.json，改条目照旧走看板和命令行；条目删了（干完、审过、手删）副本跟着删。
// 另放派活单的「只许动」解析和撞文件检查（一键启动前查），都是纯函数，单测直接测。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../shared/log";
import type { BookmarkRecord } from "./store";

const log = createLogger("bookmark");

/** 副本夹名：放在看板数据夹里。 */
export const ITEM_FILES_DIR = "条目（一条一份）";

export function itemFilePath(dir: string, id: string): string {
  return join(dir, `${id}.md`);
}

const KIND_LABEL: Record<BookmarkRecord["kind"], string> = { note: "普通条目", handoff: "交接单", dispatch: "派活单" };

/** 一条的副本正文。title＝AI 写的小标题（没有就不写）；images 把贴图标记换成完整路径（imagesForAgent）。 */
export function formatItemFile(
  record: BookmarkRecord,
  opts: { group: string; title?: string | null; images?: (text: string) => string },
): string {
  const nl = String.fromCharCode(10);
  const fix = opts.images ?? ((t: string) => t);
  const status = record.claimedBy ? `${record.claimedBy} 在干` : record.report ? `${record.reportedBy ?? "AI"} 干完了，等审` : "没人领";
  const lines = [
    `# ${opts.title || firstLine(record.text)}`,
    "",
    `> 看板「${opts.group}」组的一条${KIND_LABEL[record.kind]} · id ${record.id} · ${status}`,
    "> 这是看板自动写的副本：只读这一份就够，别去翻整组。要改内容、领活、交报告，照旧走看板命令（bookmark-cli.mjs），别改这个文件——改了也会被盖掉。",
  ];
  if (record.kind === "dispatch") {
    lines.push("> 派活单：强模型拆好的活，同一批的几张会被一键同时开出去。只动单子里「只许动」写的文件；干完 report 交报告，等调度审、用户测，别自己 done。");
  }
  lines.push("", "## 原文", "", fix(record.text));
  if (record.url) lines.push("", `链接：${record.url}`);
  if (record.detail) lines.push("", "## 详情", "", fix(record.detail));
  if (record.report) lines.push("", `## 报告（${record.reportedBy ?? "AI"}）`, "", record.report);
  return lines.join(nl) + nl;
}

function firstLine(text: string): string {
  const flat = text.replace(/\[图片:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat || "（只有图）";
}

/**
 * 把副本夹跟看板对齐：内容变了才写，看板上没了的删掉。只碰 `<id>.md`，夹里别的文件不动。
 * cache 记着上次写的内容（同一进程里省得每次读盘比较）。出任何错只记日志，不拦看板。
 */
export function syncItemFiles(
  dir: string,
  records: BookmarkRecord[],
  render: (record: BookmarkRecord) => string,
  cache: Map<string, string>,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const alive = new Set<string>();
    for (const record of records) {
      alive.add(record.id);
      const text = render(record);
      const path = itemFilePath(dir, record.id);
      if (cache.get(record.id) === text && existsSync(path)) continue;
      if (!cache.has(record.id) && existsSync(path) && readFileSync(path, "utf8") === text) {
        cache.set(record.id, text);
        continue;
      }
      writeFileSync(`${path}.tmp`, text, "utf8");
      renameSync(`${path}.tmp`, path);
      cache.set(record.id, text);
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      if (alive.has(id)) continue;
      rmSync(join(dir, name), { force: true });
      cache.delete(id);
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
  return rest
    .split(/[；;，,、]/)
    .map((s) => s.trim().replace(/^[`「『"']+|[`」』"']+$/g, "").trim())
    .filter(Boolean);
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
