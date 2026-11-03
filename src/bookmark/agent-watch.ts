// 盯三家 AI 的会话记录（2026-10-29 用户：接没接活程序自己判，拖、复制、六个点都一个逻辑；别加钩子，只靠看板程序）。
// 他把条目交给哪个窗口，那家会把他发出去的话记进本机的会话记录文件；看板读新写进来的几行，
// 认出「他发的话」里有条目单独文件路径、或者「接第 N 条 / 接捆 N」，就交给 panel-window 标成「那个窗口 在干」。
// 只认他自己发的话：AI 回的、工具结果、系统附件一概不看（AI 回话里常带路径，认了就乱标）。
// 三家记录在哪（都在他的用户夹下，按用户夹自动找）：
//   Claude Code  .claude\projects\<项目>\<会话号>.jsonl         一行 type:"user"，message.content 是字或 [{type:"text"}]，isMeta 的不算
//   Pi           .pi\agent\sessions\<项目>\<时间>_<会话号>.jsonl  一行 type:"message"，message.role:"user"
//   Antigravity  .gemini\antigravity\brain\<会话号>\.system_generated\logs\transcript.jsonl  一行 type:"USER_INPUT"，source:"USER_EXPLICIT"
// 费不费电脑：Windows 有变化才通知（fs.watch），只读新写进来的那截，读完就停。出任何错只记日志，不连坐看板。

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../shared/log";

const log = createLogger("bookmark");

export type WatchedAgent = "Claude" | "Pi" | "Antigravity";

/** 他发出去的一句话。 */
export interface SentMessage {
  agent: WatchedAgent;
  /** 会话号（窗口名从它取） */
  session: string;
  text: string;
  /** 发出的时间（毫秒） */
  at: number;
}

/** 一句话里认出的交活：条目 id（单独文件路径里来的）、看板号码、捆号码。 */
export interface HandoffHits {
  ids: string[];
  numbers: number[];
  bundles: number[];
}

/** 窗口名：家名-会话号末 4 位（Pi 的会话号开头是时间，末尾才分得开）。 */
export function windowNameFor(agent: WatchedAgent, session: string): string {
  const tail = String(session).replace(/[^0-9a-z]/gi, "").slice(-4) || "窗口";
  return `${agent}-${tail}`;
}

// 条目单独文件：<看板数据夹>\条目（一条一份）\<id>.md 或 <id>（原话）.md（拖进来、复制路径贴进来都长这样）
const ITEM_PATH = /条目（一条一份）[\\/]+([^\\/\s"'`<>|*?]+?)(?:（原话）)?\.md/g;
const NUM = "[0-9０-９一二两三四五六七八九十]+";
const BUNDLE_REF = new RegExp(`捆\\s*(${NUM})`, "g");
const ITEM_REF = new RegExp(`第\\s*(${NUM})\\s*[条号个张]|(${NUM})\\s*号`, "g");
const VERB = /接|干|做|领|弄|办|处理|开工|动手|搞定|搞一下|搞了|负责/;
// 只看不接、问进度的说法：这一句不算交活
const SKIP = /只看|看看|看一下|看下|瞅|读一下|读读|别接|不接|不用接|先别|别干|不用干|不干|干完了|做完了|弄完了|好了没|好了吗|怎么样了|进度|啥意思|什么意思|是什么|是啥/;

/** 中文数字（到九十九）换成数。 */
export function toNumber(raw: string): number {
  const s = String(raw).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(s)) return Number(s);
  const d: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!s.includes("十")) return d[s] ?? NaN;
  const [a, b] = s.split("十");
  return (a ? d[a] ?? NaN : 1) * 10 + (b ? d[b] ?? NaN : 0);
}

/** 一句话里认交活。纯函数。单独文件路径：只要这句没说「只看」就算；号码：同一小句里要有「接 / 干 / 做…」这类动词。 */
export function findHandoffs(text: string): HandoffHits {
  const hits: HandoffHits = { ids: [], numbers: [], bundles: [] };
  const raw = String(text ?? "");
  if (!SKIP.test(raw)) hits.ids = [...new Set([...raw.matchAll(ITEM_PATH)].map((m) => m[1]))];
  if (hits.ids.length) return hits;
  for (const seg of raw.split(/[。！？!?\n；;，,]/)) {
    if (!VERB.test(seg) || SKIP.test(seg)) continue;
    for (const m of seg.matchAll(BUNDLE_REF)) {
      const n = toNumber(m[1]);
      if (n > 0) hits.bundles.push(n);
    }
    for (const m of seg.replace(BUNDLE_REF, " ").matchAll(ITEM_REF)) {
      const n = toNumber(m[1] ?? m[2]);
      if (n > 0) hits.numbers.push(n);
    }
  }
  hits.numbers = [...new Set(hits.numbers)];
  hits.bundles = [...new Set(hits.bundles)];
  return hits;
}

/** 会话记录里的一行 → 他发的话（不是他发的返回 null）。纯函数。file 用来取会话号。 */
export function parseSentLine(agent: WatchedAgent, file: string, line: string): SentMessage | null {
  // 先粗筛再解析：Claude 的一行可能带几兆的截图
  if (agent === "Claude" && !line.includes('"type":"user"')) return null;
  if (agent === "Pi" && !line.includes('"role":"user"')) return null;
  if (agent === "Antigravity" && !line.includes("USER_INPUT")) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const msg = (o.message ?? {}) as { role?: unknown; content?: unknown };
  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text").map((c) => String((c as { text?: unknown }).text ?? "")).join("\n")
        : "";
  if (agent === "Claude") {
    if (o.type !== "user" || o.isMeta === true || o.isSidechain === true || msg.role !== "user") return null;
    // 工具结果也是 type:"user"，内容是 tool_result：不算他发的
    if (Array.isArray(msg.content) && msg.content.some((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "tool_result")) return null;
    const text = textOf(msg.content);
    if (!text.trim()) return null;
    return { agent, session: String(o.sessionId ?? basename(file, ".jsonl")), text, at: Date.parse(String(o.timestamp ?? "")) || Date.now() };
  }
  if (agent === "Pi") {
    if (o.type !== "message" || msg.role !== "user") return null;
    const text = textOf(msg.content);
    if (!text.trim()) return null;
    const session = basename(file, ".jsonl").split("_").pop() ?? basename(file);
    return { agent, session, text, at: Date.parse(String(o.timestamp ?? "")) || Date.now() };
  }
  if (o.type !== "USER_INPUT" || o.source !== "USER_EXPLICIT") return null;
  const text = typeof o.content === "string" ? o.content : "";
  if (!text.trim()) return null;
  // 会话号＝brain 下面那一层夹名：brain\<会话号>\.system_generated\logs\transcript.jsonl
  const session = basename(dirname(dirname(dirname(file))));
  return { agent, session, text, at: Date.parse(String(o.created_at ?? "")) || Date.now() };
}

/** 三家的记录夹和认哪些文件。home＝用户夹（验证脚本可指到假夹）。 */
export function watchRoots(home: string): { agent: WatchedAgent; dir: string; accept: (rel: string) => boolean }[] {
  return [
    { agent: "Claude", dir: join(home, ".claude", "projects"), accept: (rel) => rel.toLowerCase().endsWith(".jsonl") },
    { agent: "Pi", dir: join(home, ".pi", "agent", "sessions"), accept: (rel) => rel.toLowerCase().endsWith(".jsonl") },
    { agent: "Antigravity", dir: join(home, ".gemini", "antigravity", "brain"), accept: (rel) => /[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.test(rel) },
  ];
}

/** 掉线接手（2026-11-03 用户：窗口关了单子还锁着）：窗口名 → 那家会话记录最后写的时间、AI 最后说的两句。
 *  只认看板起的「家名-会话号末 4 位」（Claude-d981）；六个点起的 Claude-1 这类、AI 自己起的名字认不出，返回 null。
 *  同一个末 4 位撞上好几份记录，取最近写的那份。只读文件尾巴 256KB。 */
export function lookupWindow(home: string, name: string): { lastAt: number; lastWords: string[] } | null {
  const m = /^(claude|pi|antigravity)-([0-9a-z]{4})$/i.exec(String(name ?? "").trim());
  if (!m || !home) return null;
  const agent = (["Claude", "Pi", "Antigravity"] as const).find((a) => a.toLowerCase() === m[1].toLowerCase())!;
  const tail = m[2].toLowerCase();
  const root = watchRoots(home).find((r) => r.agent === agent)!.dir;
  const ends = (session: string) => session.replace(/[^0-9a-z]/gi, "").toLowerCase().endsWith(tail);
  const hits: string[] = [];
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const a of list(root)) {
    if (!a.isDirectory()) continue;
    if (agent === "Antigravity") {
      if (ends(a.name)) hits.push(join(root, a.name, ".system_generated", "logs", "transcript.jsonl"));
      continue;
    }
    for (const f of list(join(root, a.name))) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".jsonl")) continue;
      const session = agent === "Pi" ? (basename(f.name, ".jsonl").split("_").pop() ?? "") : basename(f.name, ".jsonl");
      if (ends(session)) hits.push(join(root, a.name, f.name));
    }
  }
  let best: { file: string; at: number } | null = null;
  for (const file of hits) {
    try {
      const at = statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    } catch {
      /* 刚删掉的不算 */
    }
  }
  if (!best) return null;
  return { lastAt: best.at, lastWords: lastAiWords(agent, best.file, 2) };
}

/** 会话记录尾巴里 AI 最后说的几句（每句压成一行、最长 80 字）。读不了就空着。 */
function lastAiWords(agent: WatchedAgent, file: string, count: number): string[] {
  let text = "";
  try {
    const size = statSync(file).size;
    const want = Math.min(size, 256 * 1024);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/).reverse()) {
    if (out.length >= count) break;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 截断的头一行、坏行跳过
    }
    const msg = (o.message ?? {}) as { role?: unknown; content?: unknown };
    // Antigravity 的 AI 回话长啥样还没核对过，先只给时间不给话
    const said = agent === "Claude" ? o.type === "assistant" : agent === "Pi" && o.type === "message" && msg.role === "assistant";
    if (!said) continue;
    const content = msg.content;
    const words = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text").map((c) => String((c as { text?: unknown }).text ?? "")).join(" ")
        : "";
    const one = words.replace(/\s+/g, " ").trim();
    if (one) out.push(one.length > 80 ? `${one.slice(0, 80)}…` : one);
  }
  return out.reverse();
}

/** 只认刚发的：开看板之前写进去的、续上旧会话重写的老话一概不认。 */
const FRESH_MS = 2 * 60_000;
/** 头一回碰到一份老文件，最多往回读这么多（Claude 一句带截图能有好几兆）。 */
const FIRST_READ_MAX = 16 * 1024 * 1024;

export interface AgentWatchHandle {
  stop: () => void;
}

/** 开始盯。onSent 每认出他发的一句话调一次。哪家的夹不存在就跳过那家。 */
export function startAgentWatch(home: string, onSent: (message: SentMessage) => void): AgentWatchHandle {
  const watchers: FSWatcher[] = [];
  const offsets = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();
  const started = Date.now();

  const readNew = (agent: WatchedAgent, file: string) => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    let from = offsets.get(file);
    if (from === undefined) {
      // 头一回见：开看板以后才建的从头读；以前就有的只读最后一截，再靠时间筛掉老话
      let born = 0;
      try {
        born = statSync(file).birthtimeMs;
      } catch {
        /* 读不到就当老文件 */
      }
      from = born >= started ? 0 : Math.max(0, size - FIRST_READ_MAX);
    }
    if (size < from) from = 0; // 文件被重写了
    if (size === from) return;
    const buf = Buffer.alloc(size - from);
    let fd: number | null = null;
    try {
      fd = openSync(file, "r");
      readSync(fd, buf, 0, buf.length, from);
    } catch {
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      offsets.set(file, from); // 一行还没写完，下回再读
      return;
    }
    offsets.set(file, from + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"));
    const now = Date.now();
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      const sent = parseSentLine(agent, file, line);
      if (!sent || now - sent.at > FRESH_MS || sent.at < started - FRESH_MS) continue;
      try {
        onSent(sent);
      } catch (error) {
        log.出事("认交活出错（不影响看板）", error, "watch");
      }
    }
  };

  for (const root of watchRoots(home)) {
    if (!existsSync(root.dir)) continue;
    try {
      const w = watch(root.dir, { recursive: true }, (_event, name) => {
        if (!name) return;
        const rel = String(name);
        if (!root.accept(rel)) return;
        const file = join(root.dir, rel);
        // 一句话常分几次写完：同一份文件 300ms 内只读一次
        const old = timers.get(file);
        if (old) clearTimeout(old);
        timers.set(file, setTimeout(() => {
          timers.delete(file);
          readNew(root.agent, file);
        }, 300));
      });
      w.on("error", (error) => log.出事(`盯 ${root.agent} 会话记录断了（看板照常用）`, error, "watch"));
      watchers.push(w);
      log.记(`开始盯 ${root.agent} 的会话记录：${root.dir}`, "watch");
    } catch (error) {
      log.出事(`盯不了 ${root.agent} 的会话记录（看板照常用）`, error, "watch");
    }
  }

  return {
    stop() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* 关不掉无所谓 */
        }
      }
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
