// 收单把关（2026-11-03 用户：设计夹停在 25 号、维修夹 9-24 以后没人写，靠 AI 自觉记不住，要程序卡死）。
// 一张单子干活期间有提交动了看板代码（src/bookmark），收单前问题账或设计夹里得有一份 md 是这期间改过的，不然拦下。
// 他在看板上亲手勾最后一项不拦（store.tick 里判）；git 跑不起来、路径不在，一律放行，不能因为检查坏了收不了单。

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BookmarkRecord, CloseGuard } from "./store";

/** 问题账和设计夹默认在哪（书签工具项目夹，两套系统共用 E 盘）。BOOKMARK_ISSUE_DIRS 用分号隔开可以换。 */
export const DEFAULT_RECORD_DIRS = [
  "E:\\个人AI资源管理\\10_按项目存放（某个项目专用的脚本和资料）\\01_手作园（自己从0搓的·应用网页工具）\\应用\\书签工具\\维修（排障）",
  "E:\\个人AI资源管理\\10_按项目存放（某个项目专用的脚本和资料）\\01_手作园（自己从0搓的·应用网页工具）\\应用\\书签工具\\设计思路（看板·聊定的设定·一条三本账）",
];

/** 这张单子从什么时候开始算：当前窗口领走的时间，没有就建单时间。 */
function startedAt(record: BookmarkRecord): number {
  const t = Date.parse(record.claimedAt ?? record.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** since 之后动过看板代码的提交（短号）。git 不在、不是仓库都当没有。 */
export function bookmarkCommitsSince(repo: string, since: number): string[] {
  if (!since) return [];
  const res = spawnSync("git", ["-C", repo, "log", `--since=${new Date(since).toISOString()}`, "--format=%h", "--", "src/bookmark"], { encoding: "utf8", timeout: 4000, windowsHide: true });
  if (res.status !== 0 || typeof res.stdout !== "string") return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 这几个夹（往下两层）里有没有 since 之后改过的 md。 */
export function recordWrittenSince(dirs: string[], since: number): boolean {
  const walk = (dir: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name.startsWith("_old")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && walk(full, depth - 1)) return true;
      } else if (e.name.toLowerCase().endsWith(".md")) {
        try {
          if (statSync(full).mtimeMs > since) return true;
        } catch {
          /* 刚挪走的不算 */
        }
      }
    }
    return false;
  };
  return dirs.some((d) => walk(d, 2));
}

/** 造一个把关：repo＝看板代码所在的仓库根。 */
export function makeIssueGuard(repo: string, dirs = DEFAULT_RECORD_DIRS): CloseGuard {
  return (record) => {
    const since = startedAt(record);
    const commits = bookmarkCommitsSince(repo, since);
    if (!commits.length || recordWrittenSince(dirs, since)) return null;
    return `先别收单：这张干活期间改了看板代码（提交 ${commits.slice(0, 5).join("、")}），问题账和设计夹都没写。`
      + `修毛病 → 在「${dirs[0]}」照模板记一份（发现了什么、为什么、怎么解决、现在怎样、怎么验）；`
      + `加了新设定或改了做法 → 改设计夹对应那号的设计规则和现行理由。写完再勾最后一项。`
      + `这次的提交跟看板毛病无关 → 跟他说一声，让他在看板上亲手勾最后一项。`;
  };
}
