// 运行日志。出事了先来这儿翻，别猜。
//
// ## 这套是怎么定的（2026-08-12）
//
// **目录、级别、保留期** 照资源库那套「App 日志」规范
// （`60_公用资源\20_脚本管理\App日志（各App共用·出事能查到）`）：
//   - 统一进 `%LOCALAPPDATA%\我的App日志\<App名>\`，AI 排障只认这一个地方
//   - 三级：调试 / 记录 / 出事；轻档门槛 = 记录（调试的直接丢）
//   - 判档理由：出问题用户能直接摸到这台机 → 轻档（规范的「规则层」第一问）
//   - 那套规范的执行层是 PowerShell 的 `日志.ps1`，本项目是 Electron 跑不了 ps1，
//     所以这儿是**同规范的 TS 实现**。改行格式要两边一起改，否则排障时对不上。
//
// **按功能域分文件** 是照 clawd-on-desk 学的（github.com/rullerzhou-afk/clawd-on-desk）。
// 它把 permission / session / focus / update 各写各的 `.log`，排障时直接开对应那本，
// 不用在一坨里翻。**它没有日志级别**，轮换也只是「超 1MB 就砍掉前一半」——
// 那两点没学，我们保留级别和按天保留，砍掉的日志找不回来这事不能忍。

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAME = "多Agent桌面宠物";
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_DAYS = 7;
const KEEP_FILES = 10;
const REPEAT_LIMIT = 3;

/** 一个功能域一本，照 clawd-on-desk 的分法。要加新的域，在这儿加一个名字就行。 */
export type LogArea = "app" | "window" | "session" | "permission";

export type Level = "调试" | "记录" | "出事";
const LEVEL_ORDER: Record<Level, number> = { 调试: 0, 记录: 1, 出事: 2 };

// 轻档门槛：调试的直接丢。想临时看调试，设环境变量 AGENT_PET_LOG_LEVEL=调试
let threshold: Level = process.env.AGENT_PET_LOG_LEVEL === "调试" ? "调试" : "记录";

const repeatState = new Map<LogArea, { message: string; count: number }>();
let lastError: string | null = null;

export function logRoot(): string {
  // 自测跑起来时 AGENT_PET_HUB_HOME 指向隔离目录，日志也跟着进去，
  // 别把「测试跑了 20 遍」混进用户要看的那本（2026-08-12 第一版就踩了）。
  if (process.env.AGENT_PET_HUB_HOME) return join(process.env.AGENT_PET_HUB_HOME, "logs");
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(local, "我的App日志", APP_NAME);
}

export function setLogThreshold(level: Level): void {
  threshold = level;
}

export interface AreaLogger {
  /** 干了什么。高频的东西（鼠标移动、心跳、每帧刷新）别往这儿塞。 */
  记(message: string, where?: string): void;
  /** 出事了。异常对象一起传进来，堆栈会跟着记。 */
  出事(message: string, error?: unknown, where?: string): void;
  /** 只有把门槛调到「调试」才会写。热路径上先问 `if (log.要调试())` 再拼贵字符串。 */
  调试(message: string, where?: string): void;
  要调试(): boolean;
}

/** 给某个功能域拿一本日志。各块用各块的，别混着写。 */
export function createLogger(area: LogArea): AreaLogger {
  return {
    记: (message, where) => write(area, "记录", message, where),
    出事: (message, error, where) => write(area, "出事", message, where, error),
    调试: (message, where) => write(area, "调试", message, where),
    要调试: () => LEVEL_ORDER["调试"] >= LEVEL_ORDER[threshold],
  };
}

/** 日志模块自己出的错（不会往外抛，排查时看这儿）。 */
export function lastLogError(): string | null {
  return lastError;
}

/** 启动时调一次：建目录、清过期、写一行开机记号。 */
export function startLog(extra?: Record<string, unknown>): void {
  try {
    mkdirSync(logRoot(), { recursive: true });
    cleanup();
    write("app", "记录", `===== 启动 ${APP_NAME}${extra ? " " + JSON.stringify(extra) : ""} =====`);
  } catch (error) {
    lastError = describeError(error);
  }
}

function write(area: LogArea, level: Level, message: string, where?: string, error?: unknown): void {
  // ① 收不收：级别不够当场滚蛋，后面一概不做
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  try {
    // ② 防暴涨：同一本里一样的消息连着来，只记前 3 条
    const state = repeatState.get(area);
    if (state && state.message === message) {
      state.count += 1;
      if (state.count > REPEAT_LIMIT) return;
      if (state.count === REPEAT_LIMIT) {
        appendLine(area, compose(level, `${message}（后续相同消息合并，不再逐条记）`, where));
        return;
      }
    } else {
      repeatState.set(area, { message, count: 1 });
    }
    // ③ 加料 + 洗（脱敏在 compose 里）
    let line = compose(level, message, where);
    if (error !== undefined) line += `\n    ${redact(describeError(error))}`;
    // ④ 送
    appendLine(area, line);
  } catch (failure) {
    // 日志自己坏了绝不能连累 App。留个现场给排查用。
    lastError = describeError(failure);
  }
}

function currentFile(area: LogArea): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return join(logRoot(), `${area}-${stamp}.log`);
}

function appendLine(area: LogArea, line: string): void {
  const file = currentFile(area);
  mkdirSync(logRoot(), { recursive: true });
  // 轮换：一天一本，一本写满 2MB 当天开第二本（旧的留着，不像 clawd 那样砍掉一半）
  if (existsSync(file) && statSync(file).size >= MAX_BYTES) {
    renameSync(file, file.replace(/\.log$/, `-${Date.now()}.log`));
  }
  appendFileSync(file, `${line}\n`, "utf8");
}

function compose(level: Level, message: string, where?: string): string {
  const now = new Date();
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  const site = where ? ` [${where}]` : "";
  return `${time} [${level}]${site} ${redact(message)}`;
}

// 密钥、令牌、密码一律遮掉——跟 PowerShell 版一个规矩
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /("?(?:api[_-]?key|password|passwd|secret|token|authorization)"?\s*[:=]\s*)("?[^"',\s]{4,}"?)/gi,
];

function redact(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) => (prefix ? `${prefix}***已遮***` : "***已遮***"));
  }
  return output;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null) {
    try { return JSON.stringify(error); } catch { return String(error); }
  }
  return String(error);
}

function cleanup(): void {
  const root = logRoot();
  if (!existsSync(root)) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  // 每个域各留各的份额，别让说话多的那本把别人挤掉
  const byArea = new Map<string, { path: string; time: number }[]>();
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".log")) continue;
    const area = name.split("-")[0];
    const path = join(root, name);
    const list = byArea.get(area) || [];
    list.push({ path, time: statSync(path).mtimeMs });
    byArea.set(area, list);
  }
  for (const files of byArea.values()) {
    files.sort((left, right) => right.time - left.time);
    for (const [index, file] of files.entries()) {
      if (index >= KEEP_FILES || file.time < cutoff) {
        try { unlinkSync(file.path); } catch { /* 删不掉就算了，下次再说 */ }
      }
    }
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
