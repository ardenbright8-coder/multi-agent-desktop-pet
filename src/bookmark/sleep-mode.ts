// 看板两档（2026-09-24 设定18）：☀️ 日常档 = AI 干完一条先给用户验、他说可以才删；
// 🌙 睡觉档 = 用户睡了，AI 干完写大白话报告挂在条目下面、接着领这组下一条，早上用户再审。
// 本文件只放纯函数：档位存档怎么读、到点该给哪几组开窗。存取 IO 和定时器在 panel-window。

export type BoardMode = "day" | "sleep";

/** mode.json 的内容 → 档位。只认 "sleep"，别的（缺文件、坏档、拼错）一律日常档：日常档是安全的那一档。 */
export function parseBoardMode(raw: string): BoardMode {
  try {
    return (JSON.parse(raw) as { mode?: unknown })?.mode === "sleep" ? "sleep" : "day";
  } catch {
    return "day";
  }
}

/** 睡觉档每半小时看一眼用的条目字段。 */
export interface NudgeRow {
  assignee: string | null;
  claimedBy: string | null;
  report: string | null;
}

/**
 * 睡觉档到点看一眼：哪几组「还有活、又没人在干」→ 开窗贴好领活那句（回车还是用户按）。
 * nudged＝开过窗、还没人来领的组：同一回卡住只开一次，免得半夜一窗接一窗。
 * 返回 launch＝这回要开的组；clear＝有人在干了、从记账里清掉的组（下回卡住还能再开）。
 */
export function planNudges(rows: NudgeRow[], groups: string[], nudged: ReadonlySet<string>): { launch: string[]; clear: string[] } {
  const launch: string[] = [];
  const clear: string[] = [];
  for (const group of groups) {
    const mine = rows.filter((r) => (r.assignee ?? "").toLowerCase() === group.toLowerCase() && !r.report);
    if (mine.some((r) => r.claimedBy)) {
      if (nudged.has(group)) clear.push(group);
      continue;
    }
    if (mine.length && !nudged.has(group)) launch.push(group);
  }
  return { launch, clear };
}
