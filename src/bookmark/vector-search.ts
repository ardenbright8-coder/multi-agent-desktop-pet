// 「🔍 找」按意思找（2026-10-27 用户：发一个意思差不多的词也要搜到）：借本地搜索引擎（OHS）给看板单切的那块
// kb-search-board（每条单独文件一份，变向量走阿里云），跟按字找、小模型认项目名三路一起选中。
// 入口脚本两套系统不在一处（根跑 D 盘那份，燊一修跑 E 盘那份，底层零件跟各自的 node 版本对得上），
// 写在看板数据夹「看板搜索.json」里按顺序试，哪个跑通记住哪个；改了不用改代码。

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bookmarkDataDirectory } from "../shared/paths";

const CONFIG_FILE = "看板搜索.json";
const DEFAULT_SCRIPTS = [
  "D:\\A-gen-yonghuguanli\\本地库搜索\\ohs-board.ps1",
  "E:\\个人AI资源管理\\60_公用资源（钩子·skill·搜索引擎·可后期扩展）\\搜索引擎（MCP）\\本地库搜索（OHS·搜自己的资源库·不联网）\\ohs-board.ps1",
];
/** 最像的那条语义分低于这个＝没有意思对得上的（实测：对得上 0.46 起，问「今天天气」最高 0.36）。 */
export const VECTOR_MIN_SEMANTIC = 0.4;
/** 只取最像的前几条，别把沾边的全选上。 */
export const VECTOR_TOP = 3;
const TIMEOUT_MS = 8_000;

let working: string | null = null;

function readScripts(): string[] {
  const path = join(bookmarkDataDirectory(), CONFIG_FILE);
  try {
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify({
        说明: "看板「🔍 找」按意思找用哪个搜索入口（本地搜索引擎给看板切的 kb-search-board）。按顺序试，这台电脑上跑得通哪个用哪个。",
        入口: DEFAULT_SCRIPTS,
      }, null, 2), "utf8");
      return DEFAULT_SCRIPTS;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as { 入口?: unknown };
    const list = Array.isArray(parsed.入口) ? parsed.入口.map(String).filter(Boolean) : [];
    return list.length ? list : DEFAULT_SCRIPTS;
  } catch {
    return DEFAULT_SCRIPTS;
  }
}

interface Hit { path?: string; scores?: { semantic?: number | null } }

/** 跑一个入口脚本拿结果；跑不通就抛错。 */
function runScript(script: string, query: string): Promise<Hit[]> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "search", query, "--limit", "6", "--json"],
      { timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const parsed: unknown = JSON.parse(String(stdout).trim() || "[]");
          resolve(Array.isArray(parsed) ? (parsed as Hit[]) : []);
        } catch {
          reject(new Error("搜索入口吐的不是 JSON"));
        }
      });
  });
}

/** 从搜索结果挑出条目 id：最像那条够像才要，只要前 VECTOR_TOP 条。单独文件名就是「条目id.md」。 */
export function pickVectorIds(hits: Hit[]): string[] {
  const ranked = hits.filter((h) => typeof h.path === "string" && typeof h.scores?.semantic === "number");
  if (!ranked.length || (ranked[0].scores!.semantic as number) < VECTOR_MIN_SEMANTIC) return [];
  return ranked.slice(0, VECTOR_TOP).map((h) => String(h.path).replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/i, ""));
}

// 条目改了要跟着重算（2026-10-27 自审）：搜索引擎只在 AI 窗口挂着它时才自己跟，看板这边搜不会顺手更新。
// 一有改动等 20 秒没新改动，后台跑一次增量重建（只算改过的，约 3 秒），不挡着搜索。
const REINDEX_QUIET_MS = 20_000;
let reindexTimer: NodeJS.Timeout | null = null;
let reindexing = false;

export function scheduleVectorReindex(): void {
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    if (reindexing) return scheduleVectorReindex();
    const script = working ?? readScripts().find((s) => existsSync(s));
    if (!script) return;
    reindexing = true;
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "reindex"],
      { timeout: 120_000, windowsHide: true }, () => { reindexing = false; });
  }, REINDEX_QUIET_MS);
  reindexTimer.unref?.();
}

/** 按意思找看板条目，返回条目 id。入口都跑不通就抛错（界面说一声「按意思找没连上」，按字找照常）。 */
export async function vectorSearch(query: string): Promise<string[]> {
  const scripts = working ? [working] : readScripts().filter((s) => existsSync(s));
  if (!scripts.length) throw new Error(`没找到搜索入口（看板数据夹「${CONFIG_FILE}」里改）`);
  let last: unknown = null;
  for (const script of scripts) {
    try {
      const hits = await runScript(script, query);
      working = script;
      return pickVectorIds(hits);
    } catch (error) {
      last = error;
      if (working === script) working = null;
    }
  }
  throw last instanceof Error ? last : new Error("按意思找没连上");
}
