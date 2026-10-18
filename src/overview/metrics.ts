// 板块与内存总览：把 Electron 给的各进程内存换成人话、算绿黄红和还能加多少。纯函数，测试 testkit/tests/overview-metrics.test.ts。
//
// 警戒线怎么定的（2026-10-18）：这台机 32GB，常要腾内存给出图、游戏；常驻小工具一般几十到三五百兆（微信三五百兆），
// 所以整个程序 800MB 以内算绿，800～1200 黄（该想想新功能另开一个自启程序），1200 以上红。
// 用的是「专用内存」（每个进程自己独占的那部分），比任务管理器里把共用部分重复算的总数准。

export const YELLOW_MB = 800;
export const RED_MB = 1200;
/** 只在后台干活、不开窗口的板块，大约多占这么多。 */
export const BACKGROUND_BLOCK_MB = 15;
/** 带一个窗口的板块，大约多占这么多（一个窗口单独一个进程）。 */
export const WINDOW_BLOCK_MB = 80;

export interface ProcessSample {
  pid: number;
  /** Electron 的进程类型：Browser / GPU / Utility / Tab …… */
  type: string;
  serviceName?: string;
  /** 专用内存，KB。拿不到（非 Windows）时用工作集顶上。 */
  privateKB: number;
  /** 这个进程里住着哪些窗口（窗口标题）。 */
  windowTitles: string[];
}

export interface ProcessRow {
  pid: number;
  label: string;
  what: string;
  mb: number;
}

export type Level = "绿" | "黄" | "红";

export interface MemorySummary {
  totalMB: number;
  level: Level;
  yellowMB: number;
  redMB: number;
  /** 离黄线还有多少 MB（已过线就是 0）。 */
  roomMB: number;
  /** 还能加几个后台板块 / 带窗口的板块，粗估。 */
  roomBackground: number;
  roomWindow: number;
  rows: ProcessRow[];
}

const WINDOW_NAMES: Record<string, string> = {
  "多Agent桌面宠物": "桌宠画框",
  "Agent 看板": "Agent 看板",
  "Agent命令快捷窗口": "Ctrl+Q 按钮列",
};

/** 一个进程用大白话叫什么、干什么。 */
export function describeProcess(sample: ProcessSample): { label: string; what: string } {
  if (sample.type === "Browser") return { label: "主控", what: "大脑：所有后台的活都在这跑（盯各家 AI、热键、看板数据、vivo 复制）" };
  if (sample.type === "GPU") return { label: "画图帮手", what: "把窗口画到屏幕上，里面一大块是显卡那边的内存" };
  if (sample.type === "Utility" && /network/i.test(sample.serviceName || "")) return { label: "联网帮手", what: "管上网收发" };
  if (sample.type === "Tab") {
    const names = sample.windowTitles.map((title) => WINDOW_NAMES[title] || title).filter(Boolean);
    return { label: `窗口：${names.join("、") || "（没标题）"}`, what: "一个窗口单独一个进程，关了窗口就省下来" };
  }
  return { label: "其他帮手", what: `${sample.type}${sample.serviceName ? ` · ${sample.serviceName}` : ""}` };
}

export function levelOf(totalMB: number): Level {
  if (totalMB >= RED_MB) return "红";
  if (totalMB >= YELLOW_MB) return "黄";
  return "绿";
}

/** 汇总。skipPids 里的进程（总览窗口自己）不算，免得一打开总览数字就涨。 */
export function summarize(samples: readonly ProcessSample[], skipPids: readonly number[] = []): MemorySummary {
  const rows = samples
    .filter((sample) => !skipPids.includes(sample.pid))
    .map((sample) => ({ pid: sample.pid, ...describeProcess(sample), mb: Math.round(sample.privateKB / 1024) }))
    .sort((a, b) => b.mb - a.mb);
  const totalMB = rows.reduce((sum, row) => sum + row.mb, 0);
  const roomMB = Math.max(0, YELLOW_MB - totalMB);
  return {
    totalMB,
    level: levelOf(totalMB),
    yellowMB: YELLOW_MB,
    redMB: RED_MB,
    roomMB,
    roomBackground: Math.floor(roomMB / BACKGROUND_BLOCK_MB),
    roomWindow: Math.floor(roomMB / WINDOW_BLOCK_MB),
    rows,
  };
}
