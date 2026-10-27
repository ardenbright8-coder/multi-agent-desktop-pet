// AI 整理看板（设定21，2026-10-12 用户拍板）：定时把每组里新来的条目交给便宜模型，
// 它只回「放进哪捆 / 跟谁开新捆 / 不动」。真正改捆只走 store 的 ai* 口子，规矩在代码里卡死：
// 不跨组、不改字、不碰用户动过的、不把捆里的拿出来、不碰在干的。模型说错的那条直接丢，不连坐别的。
// 整理完接着「检查」（第四版，2026-10-12 用户：只提示不改）：整组连用户捆的一起看，挑放错的挂小橙点，用户点「知道了」就不再提。
// 模型（哪家地址＋钥匙＋模型名，能加多家）存 organizer.json（看板私有数据夹，不进 git）。纯函数在前，跑一轮的在后。
// 给模型的规矩正文（读条目、分捆、起捆名、检查）不写在这里，在仓库根 skills（看板内置模型用·整理捆的规矩）\ 里一步一份（2026-10-13 用户：
// 外面 AI 用看板的说明书和内置模型整理的规矩分成两套）。这里只读进来、填上代码里的数。

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { BookmarkRecord, BookmarkStore, BundleMeta } from "./store";

export const DEFAULT_PROVIDER = "Command Code";
export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_MODELS = ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash"];
/** 刚写的条目先不整理：输入框边写边存，写到一半就被捆走会乱。 */
export const MIN_AGE_MS = 3 * 60 * 1000;
/** 读条目时一条最多带几张图（第五版 2026-10-13 用户：每张图都要看，一条一条看压力小）。 */
const MAX_IMAGES_PER_ITEM = 12;
/** 分捆那一步：还没读成小结的条目才带原图，兜底用。 */
const MAX_IMAGES_PER_GROUP = 12;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** 捆标题最长几个字（2026-10-13 用户：上限 39，尽量写满）。 */
export const MAX_BUNDLE_NAME = 39;
/** 每条小标题最长几个字。 */
export const MAX_ITEM_TITLE = 200;
/** 读条目同时发几条（一条一问，太多会被限流；2026-10-13 从 3 提到 6 提速）。 */
const NOTE_CONCURRENCY = 6;
export const BANNED_NAMES = ["杂项", "其他", "其它", "待办", "未分类", "零散", "综合", "混合"];
/** 整理记录最多留几次（用户：干完的不留账，不然越攒越多）。 */
export const MAX_RUNS = 50;

/** 一个能用的模型：哪家（随便起的名字）、地址、钥匙、模型名（2026-10-12 用户：换别家 AI 也能加）。 */
export interface ModelEntry {
  id: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OrganizerConfig {
  models: ModelEntry[];
  /** 现在用哪个（ModelEntry.id）。 */
  current: string;
  enabled: boolean;
  intervalHours: number;
  /** 思考档位：low / high / max（2026-10-12 用户：两个小模型开到高档，能手动调）。 */
  effort: Effort;
}

export type Effort = "low" | "high" | "max";
export const EFFORTS: Effort[] = ["low", "high", "max"];
/** 档位越高思考越长，输出上限跟着放，免得思考吃光上限、正文为空。 */
const MAX_TOKENS: Record<Effort, number> = { low: 16000, high: 32000, max: 64000 };

/** 地址统一成「…/v1」这种：去掉结尾的斜杠，用户整段贴了 /chat/completions 也认。 */
export function cleanBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
}

export function modelLabel(m: ModelEntry): string {
  return `${m.provider} · ${m.model}`;
}

function parseEntry(v: unknown, i: number): ModelEntry | null {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const model = String(r.model ?? "").trim();
  const baseUrl = cleanBaseUrl(String(r.baseUrl ?? ""));
  if (!model || !/^https?:\/\//i.test(baseUrl)) return null;
  return {
    id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : `m${i + 1}`,
    provider: String(r.provider ?? "").trim() || hostOf(baseUrl),
    baseUrl,
    apiKey: typeof r.apiKey === "string" ? r.apiKey.trim() : "",
    model,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "自定义";
  }
}

export function parseOrganizerConfig(raw: unknown): OrganizerConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.models) ? r.models : [];
  let models: ModelEntry[];
  if (list.some((m) => m && typeof m === "object")) {
    models = list.map(parseEntry).filter((m): m is ModelEntry => Boolean(m));
  } else {
    // 老格式：一个地址一把钥匙，models 只是模型名。搬成新格式，默认两个排前面。
    const baseUrl = typeof r.baseUrl === "string" && r.baseUrl.trim() ? cleanBaseUrl(r.baseUrl) : DEFAULT_BASE_URL;
    const apiKey = typeof r.apiKey === "string" ? r.apiKey.trim() : "";
    const names = [...new Set([...DEFAULT_MODELS, ...list.map((m) => String(m ?? "").trim()).filter(Boolean)])];
    const provider = baseUrl === DEFAULT_BASE_URL ? DEFAULT_PROVIDER : hostOf(baseUrl);
    models = names.map((model, i) => ({ id: `m${i + 1}`, provider, baseUrl, apiKey, model }));
  }
  const seen = new Set<string>();
  models = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  if (!models.length) models = DEFAULT_MODELS.map((model, i) => ({ id: `m${i + 1}`, provider: DEFAULT_PROVIDER, baseUrl: DEFAULT_BASE_URL, apiKey: "", model }));
  const current =
    (typeof r.current === "string" && models.find((m) => m.id === r.current)?.id) ||
    (typeof r.model === "string" && models.find((m) => m.model === r.model)?.id) ||
    models[0].id;
  const hours = Number(r.intervalHours);
  return {
    models,
    current,
    enabled: r.enabled !== false,
    intervalHours: Number.isFinite(hours) && hours >= 0.25 && hours <= 48 ? hours : 2,
    effort: EFFORTS.includes(r.effort as Effort) ? (r.effort as Effort) : "high",
  };
}

export function activeModel(config: OrganizerConfig): ModelEntry {
  return config.models.find((m) => m.id === config.current) ?? config.models[0];
}

/** 加 / 改一个模型时过一遍：哪家、地址、模型名都要像样；钥匙加的时候必填，改的时候留空＝不改。 */
export function checkModelInput(input: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown }, adding: boolean): { provider: string; baseUrl: string; apiKey: string; model: string } {
  const provider = String(input.provider ?? "").trim();
  const baseUrl = cleanBaseUrl(String(input.baseUrl ?? ""));
  const apiKey = String(input.apiKey ?? "").trim();
  const model = String(input.model ?? "").trim();
  if (!provider || provider.length > 30) throw new Error("名字填一下（随便起，30 字以内，比如 DeepSeek 官方）");
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new Error("地址要以 http:// 或 https:// 开头，比如 https://api.deepseek.com/v1");
  if (!model || /\s/.test(model) || model.length > 120) throw new Error("模型名不能空、不能带空格，最长 120 字");
  if (adding && !apiKey) throw new Error("钥匙要填");
  if (apiKey.length > 500 || /\s/.test(apiKey)) throw new Error("钥匙不像钥匙（不能带空格，最长 500 字）");
  return { provider, baseUrl, apiKey, model };
}

// ── 分组：跟看板上看到的一样（各 agent 组 + 交接单专区），待定区不整理 ──

export interface OrganizerGroup {
  label: string;
  records: BookmarkRecord[];
}

export function groupsForOrganizer(records: BookmarkRecord[], agents: string[]): OrganizerGroup[] {
  const lower = new Map(agents.map((a) => [a.toLowerCase(), a]));
  const byAgent = new Map<string, BookmarkRecord[]>();
  const handoffs: BookmarkRecord[] = [];
  for (const r of records) {
    const owner = r.assignee ? lower.get(r.assignee.toLowerCase()) : undefined;
    if (owner) {
      if (!byAgent.has(owner)) byAgent.set(owner, []);
      byAgent.get(owner)!.push(r);
    } else if (r.kind === "handoff" && !r.assignee) {
      handoffs.push(r);
    }
  }
  const out: OrganizerGroup[] = agents.filter((a) => byAgent.has(a)).map((a) => ({ label: a, records: byAgent.get(a)! }));
  if (handoffs.length) out.push({ label: "交接单专区", records: handoffs });
  return out;
}

// ── 给模型的一份题：编号用 N1/O1/B1 这种短号（弱模型抄长 id 容易抄错），代码里再换回真 id ──

export interface GroupTask {
  label: string;
  /** 短号 → 真条目 id */
  items: Map<string, string>;
  /** 短号 → 真捆号 */
  bundles: Map<string, string>;
  newAliases: string[];
  oldAliases: string[];
  /** 这一组这次算「看过」的条目（含 AI 不能动的新条目，免得下次又当新的送）。 */
  seenIds: string[];
  text: string;
  images: { alias: string; file: string }[];
  /** 条目短号 → 读条员认出的项目（projectKey 过的，认不出的不进来）。过筛用：项目不一样的不许捆一起。 */
  projects: Map<string, string>;
  /** 捆短号 → 捆里各条认出的项目（同上）。 */
  bundleProjects: Map<string, Set<string>>;
}

/** 项目名比对用（2026-10-27 用户：一捆就是一个应用、一件事）：去空格、不管大小写；「认不出」和空的算不知道，返回 null。 */
export function projectKey(project: string | null | undefined): string | null {
  const key = String(project ?? "").replace(/\s+/g, "").toLowerCase();
  return key && key !== "认不出" ? key : null;
}

export interface TaskOptions {
  meta: Record<string, BundleMeta>;
  openBundle: (bundleId: string) => boolean;
  now: number;
  minAgeMs?: number;
  attachmentsDir?: string;
  /** 规矩页「AI 每次收到的题目」用：散着的（你动过的也算）都当新条目，好让用户看到题目长什么样。 */
  previewAll?: boolean;
  /** 读条目写好的小卡片：有就拿它出题，不再带原图。 */
  notes?: NoteBook;
}

function movable(r: BookmarkRecord): boolean {
  return !r.bundleId && !r.userPinned && !r.claimedBy && !r.report;
}

export function cleanText(record: BookmarkRecord, limit = 300): string {
  let t = record.text.replace(/\[图片:[^\]]*\]/g, "[图]").replace(/\s+/g, " ").trim();
  if (t.length > limit) t = `${t.slice(0, limit)}…`;
  if (record.kind === "handoff") t = `（交接单）${t}`;
  if (record.kind === "dispatch") t = `（派活单）${t}`;
  if (record.detail) {
    const d = record.detail.replace(/\s+/g, " ").trim();
    t += ` ｜详情开头：${d.length > 200 ? `${d.slice(0, 200)}…` : d}`;
  }
  return t;
}

/** 给人看的一小截（记录、提示里用）：不带详情、不带交接单前缀。 */
export function shortText(record: BookmarkRecord, limit = 24): string {
  return cleanText({ ...record, detail: null, kind: "note" }, limit);
}

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

// ── 读条目（第五版，2026-10-13 用户：一条一条看、每张图都看，先给每条写小标题和小结，再拿小结去分捆）──

export interface ItemNote {
  /** 哪个项目（2–10 字） */
  project: string;
  /** 小标题：这个项目里哪一块＋要干的活，不带项目名。板上第一行显示它 */
  title: string;
  /** 小结：这条具体要干哪几件事。分捆、检查、写捆标题都看它，不再看原文和图 */
  summary: string;
  /** 读的时候条目长什么样（字、详情、图）。变了就重读 */
  key: string;
}

/** 条目 id → 小卡片。存看板数据夹 AI条目小结.json。 */
export type NoteBook = Record<string, ItemNote>;

/** 内容指纹带上读条目规矩：规矩一改，下一轮每条都按新规矩重读（2026-10-13：改了规矩却没生效）。 */
export function noteKey(r: BookmarkRecord): string {
  return fnv(`${r.text}\n${r.detail ?? ""}\n${r.attachments.join(",")}\n${fnv(ITEM_RULES)}`);
}

/** 这条的小卡片还作数吗（读过、读完没改过）。 */
export function freshNote(r: BookmarkRecord, book: NoteBook | undefined): ItemNote | null {
  const n = book?.[r.id];
  return n && n.key === noteKey(r) ? n : null;
}

export function parseNoteBook(raw: unknown): NoteBook {
  const out: NoteBook = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = (v ?? {}) as Record<string, unknown>;
    if (typeof n.title === "string" && typeof n.key === "string") {
      out[id] = { project: String(n.project ?? ""), title: n.title, summary: String(n.summary ?? ""), key: n.key };
    }
  }
  return out;
}

/** 条目删了，小卡片跟着删（用户：干完的不留账）。 */
export function liveNoteBook(book: NoteBook, records: BookmarkRecord[]): NoteBook {
  const alive = new Set(records.map((r) => r.id));
  return Object.fromEntries(Object.entries(book).filter(([id]) => alive.has(id)));
}

// ── 给模型的规矩：从仓库根 skills（看板内置模型用·整理捆的规矩）夹里一步一份读进来 ──

/** 内置模型的规矩夹名。开发时读仓库根那份（改完重开看板就生效），打包后读拷进 dist 的那份。 */
export const RULES_DIR = "skills（看板内置模型用·整理捆的规矩）";
/** 读不到的规矩文件：整理开跑前拦下来报给用户，别拿空规矩去问模型。 */
export const missingRuleFiles: string[] = [];

/** 读一份规矩：去掉开头 --- 包着的说明（给维护的 AI 看的），剩下的原样当规矩。 */
export function loadRule(name: string, dirs = [join(__dirname, "..", "..", RULES_DIR), join(__dirname, "..", RULES_DIR)]): string {
  for (const dir of dirs) {
    const file = join(dir, `${name}.md`);
    try {
      if (!existsSync(file)) continue;
      return readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    } catch {
      // 读不了就看下一个地方。
    }
  }
  missingRuleFiles.push(`${name}.md`);
  return "";
}

/** 规矩里的 {{名字}} 换成值；没给值的原样留着，测试能查出来。 */
export function fillRule(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (m, key: string) => values[key.trim()] ?? m);
}

function needRules(): void {
  if (missingRuleFiles.length) throw new Error(`内置模型的规矩文件读不到：${RULES_DIR} 夹里的 ${[...new Set(missingRuleFiles)].join("、")}`);
}

/** 读条目规矩（第一步）。 */
export const ITEM_RULES = loadRule("读条目");

export interface ItemTask {
  text: string;
  images: string[];
}

/** 看板上已经认出的项目名（去掉认不出的），读新条目时附在题目末尾，让同一个东西只用一个名字（2026-10-13：同一个面板被写成三种名字，分捆分不到一起）。 */
export function knownProjects(book: NoteBook): string[] {
  const names = Object.values(book).map((n) => n.project.trim()).filter((p) => p && p !== "认不出");
  return [...new Set(names)].slice(0, 40);
}

/** 一条的题：全文、详情、它带的每张图（有标注版用标注版）。图片标记换成 [图1] [图2]，跟后面附的图对上号。 */
export function buildItemTask(r: BookmarkRecord, attachmentsDir?: string, projects: string[] = []): ItemTask {
  const images: string[] = [];
  const order = new Map<string, number>();
  if (attachmentsDir) {
    for (const name of r.attachments) {
      if (images.length >= MAX_IMAGES_PER_ITEM) break;
      const marked = join(attachmentsDir, `${name}.marked.png`);
      const file = existsSync(marked) ? marked : join(attachmentsDir, name);
      try {
        if (existsSync(file) && statSync(file).size <= MAX_IMAGE_BYTES) {
          images.push(file);
          order.set(name, images.length);
        }
      } catch {
        // 图读不了就当没有，不拦读条。
      }
    }
  }
  let body = r.text.replace(/\[图片:([^\]]*)\]/g, (_m, name: string) => (order.has(name) ? `[图${order.get(name)}]` : "[图]")).trim();
  if (body.length > 4000) body = `${body.slice(0, 4000)}…`;
  const lines = [r.kind === "handoff" ? "这条是交接单（上一个 AI 窗口没干完留下的活）：" : r.kind === "dispatch" ? "这条是派活单（强模型拆好、等别的 AI 窗口领的活）：" : "这条：", body];
  if (r.detail) {
    const d = r.detail.trim();
    lines.push("", "详情：", d.length > 2500 ? `${d.slice(0, 2500)}…` : d);
  }
  if (images.length) lines.push("", `这条带 ${images.length} 张图，按 [图1] [图2] 的顺序附在后面，每张都看。`);
  if (projects.length) lines.push("", `看板上别的条目已经认出的项目：${projects.join("、")}`);
  return { text: lines.join("\n"), images };
}

export function parseItemNote(text: string, key: string): ItemNote {
  const raw = parsePlanText(text) as Record<string, unknown>;
  const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().replace(/^["「]|["」]$/g, "").slice(0, n);
  const title = clip(raw.title, MAX_ITEM_TITLE);
  if (title.length < 4) throw new Error("模型没写小标题");
  return { project: clip(raw.project, 16) || "认不出", title, summary: clip(raw.summary, 300), key };
}

/** 谁该读：没读过的、读完又改过的。在干的、待审的也读——板上每条都要有小标题。刚写的先不读（可能还在写）。 */
export function recordsNeedingNotes(records: BookmarkRecord[], agents: string[], book: NoteBook, now: number, minAgeMs = MIN_AGE_MS): BookmarkRecord[] {
  return groupsForOrganizer(records, agents)
    .flatMap((g) => g.records)
    .filter((r) => !freshNote(r, book) && now - Date.parse(r.createdAt) >= minAgeMs);
}

/** 题目里写一条：读过的用小卡片（项目、小标题、小结），没读成的退回原文。 */
function lineOf(r: BookmarkRecord, notes: NoteBook | undefined, limit: number): string {
  const n = freshNote(r, notes);
  if (!n) return cleanText(r, limit);
  return `${r.kind === "handoff" ? "（交接单）" : r.kind === "dispatch" ? "（派活单）" : ""}【${n.project}】${n.title}｜${n.summary}`;
}

export function buildGroupTask(group: OrganizerGroup, opts: TaskOptions): GroupTask | null {
  const minAge = opts.minAgeMs ?? MIN_AGE_MS;
  const oldEnough = (r: BookmarkRecord) => opts.now - Date.parse(r.createdAt) >= minAge;
  const unseen = opts.previewAll ? group.records : group.records.filter((r) => !r.sortedAt && oldEnough(r));
  const fresh = unseen.filter(opts.previewAll ? (r) => !r.bundleId && !r.claimedBy && !r.report : movable);
  if (!fresh.length) return null;
  const items = new Map<string, string>();
  const bundles = new Map<string, string>();
  const projects = new Map<string, string>();
  const bundleProjects = new Map<string, Set<string>>();
  const keyOf = (r: BookmarkRecord) => projectKey(opts.notes?.[r.id]?.project);
  const lines: string[] = [`分组：${group.label}`, ""];

  const bundleIds = [...new Set(group.records.map((r) => r.bundleId).filter((b): b is string => Boolean(b)))].filter(opts.openBundle);
  lines.push("【已有的捆】（可以把新条目放进去）");
  if (!bundleIds.length) lines.push("（没有）");
  bundleIds.forEach((bid, i) => {
    const alias = `B${i + 1}`;
    bundles.set(alias, bid);
    const members = group.records.filter((r) => r.bundleId === bid);
    bundleProjects.set(alias, new Set(members.map(keyOf).filter((k): k is string => Boolean(k))));
    const name = opts.meta[bid]?.name ?? cleanText(members[0], 16);
    lines.push(`${alias}「${name}」，里面有：`);
    for (const m of members) lines.push(`  - ${lineOf(m, opts.notes, 120)}`);
  });
  lines.push("");

  const old = opts.previewAll ? [] : group.records.filter((r) => r.sortedAt && movable(r));
  const oldAliases: string[] = [];
  lines.push("【散着的旧条目】（以前看过、没捆；可以拉来跟新条目凑新捆，单独不用管）");
  if (!old.length) lines.push("（没有）");
  old.forEach((r, i) => {
    const alias = `O${i + 1}`;
    items.set(alias, r.id);
    oldAliases.push(alias);
    const k = keyOf(r);
    if (k) projects.set(alias, k);
    lines.push(`${alias} ${lineOf(r, opts.notes, 160)}`);
  });
  lines.push("");

  const images: { alias: string; file: string }[] = [];
  const newAliases: string[] = [];
  lines.push("【新条目】（这次要你处理的，每条都要给结果）");
  fresh.forEach((r, i) => {
    const alias = `N${i + 1}`;
    items.set(alias, r.id);
    newAliases.push(alias);
    const k = keyOf(r);
    if (k) projects.set(alias, k);
    let pics = 0;
    const note = freshNote(r, opts.notes);
    if (opts.attachmentsDir && !note) {
      for (const name of r.attachments) {
        if (images.length >= MAX_IMAGES_PER_GROUP) break;
        const marked = join(opts.attachmentsDir, `${name}.marked.png`);
        const file = existsSync(marked) ? marked : join(opts.attachmentsDir, name);
        try {
          if (existsSync(file) && statSync(file).size <= MAX_IMAGE_BYTES) {
            images.push({ alias, file });
            pics += 1;
          }
        } catch {
          // 图读不了就当没有，不拦整理。
        }
      }
    }
    lines.push(`${alias} ${lineOf(r, opts.notes, 300)}${pics ? `（带 ${pics} 张图，见下面标着 ${alias} 的图）` : ""}`);
  });

  return { label: group.label, items, bundles, newAliases, oldAliases, seenIds: unseen.map((r) => r.id), text: lines.join("\n"), images, projects, bundleProjects };
}

/** 捆标题怎么写：开新捆、捆里加了条目重写标题都照这一段。字数上限、不许用的词拿代码里真卡的数填。 */
const BUNDLE_NAME_GUIDE = fillRule(loadRule("捆标题写法"), { 捆标题最多几个字: String(MAX_BUNDLE_NAME), 捆名不许用的词: BANNED_NAMES.join("、") });

// ── 搜看板（2026-10-27 用户：说一句「Agent看板」，把这摊活全拉出来，好批量剪走）──

/** 字面找：去空格、不管大小写，项目名、小标题、原文、详情里带这几个字就算。 */
export function searchByText(records: BookmarkRecord[], book: NoteBook, query: string): string[] {
  const key = projectKey(query);
  if (!key) return [];
  const flat = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
  return records
    .filter((r) => {
      const n = book[r.id];
      return [n?.project, n?.title, r.text, r.detail].some((s) => flat(s).includes(key));
    })
    .map((r) => r.id);
}

export const SEARCH_RULES = [
  "你是看板的找东西助手。用户想把看板上讲某个项目的条目全找出来，给了一句话（多半是语音转的字，名字常说歪）。",
  "下面是看板上已经认出的全部项目名。挑出跟用户要找的是同一个东西的那几个；只是大类相同的不算（都跟 AI 有关、都是界面问题都不算）。",
  "例：要找「AG的看板」→ 挑「Agent看板」；要找「酒馆」→ 挑「酒馆」「酒馆出图」；一个都对不上就给空数组。",
  "只能从给的项目名里原样挑，不许编新的。只输出一个 JSON，不要解释、不要 markdown 代码块：{\"projects\":[\"Agent看板\"]}",
].join("\n");

/** 小模型挑项目名：只送项目名清单（几十个词），快、便宜。回来的只认清单里有的。 */
export async function askSearchProjects(query: string, projects: string[], config: OrganizerConfig, fetchFn: FetchFn, timeoutMs = 60000): Promise<string[]> {
  if (!projects.length) return [];
  return askJson(config, [
    { role: "system", content: SEARCH_RULES },
    { role: "user", content: `用户要找：${query}\n看板上的项目名：${projects.join("、")}` },
  ], fetchFn, timeoutMs, (reply) => {
    const raw = parsePlanText(reply) as { projects?: unknown };
    if (!Array.isArray(raw.projects)) throw new Error("模型没回项目名清单");
    return raw.projects.map((p) => String(p ?? "").trim()).filter((p) => projects.includes(p));
  });
}

/** 捆里的条目变了，重写捆标题（第三步）。 */
export const BUNDLE_NAME_RULES = fillRule(loadRule("起捆名"), { 捆标题写法: BUNDLE_NAME_GUIDE });

/** 分捆（第二步）。写给弱模型：很细、带对错例子、说清违规的下场。改了先跑 organizer 单测。 */
export const ORGANIZER_RULES = fillRule(loadRule("分捆"), { 捆标题写法: BUNDLE_NAME_GUIDE });

/** 检查（第四步，2026-10-12 用户：放错的给个提示，不改；我还是按我的来）。整组连用户捆的一起看。 */
export const CHECK_RULES = loadRule("检查");

// ── 读模型的回答：先挖出 JSON，再逐条按规矩过筛 ──

export interface RawPlan {
  join?: unknown;
  create?: unknown;
  skip?: unknown;
  hints?: unknown;
}

/** 补 JSON：字符串里的英文双引号，后面紧跟的不是 , : } ] 就当成字里的引号转义掉；字里的直接换行换成 \n。 */
export function repairJson(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === "\\") {
      out += c + (s[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\n") out += "\\n";
      continue;
    }
    if (c === '"') {
      const next = s.slice(i + 1).trimStart()[0];
      if (next === undefined || ",:}]".includes(next)) {
        out += c;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += c;
  }
  return out;
}

export function parsePlanText(text: string): RawPlan {
  const body = String(text ?? "").replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没回 JSON");
  const raw = body.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // 弱模型常在字里夹英文双引号、直接换行，把 JSON 弄坏（2026-10-13 两次「没读成」都是这个）。补好再读一次。
    try {
      parsed = JSON.parse(repairJson(raw));
    } catch {
      throw error;
    }
  }
  if (!parsed || typeof parsed !== "object") throw new Error("模型回的不是对象");
  return parsed as RawPlan;
}

function cleanWhy(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface CleanPlan {
  joins: { id: string; bundleId: string; why: string }[];
  creates: { name: string; ids: string[]; why: string }[];
  /** 丢掉的说法（写进日志）。 */
  dropped: string[];
}

export function validatePlan(raw: RawPlan, task: GroupTask): CleanPlan {
  const used = new Set<string>();
  const out: CleanPlan = { joins: [], creates: [], dropped: [] };
  const isNew = (a: string) => task.newAliases.includes(a);
  const isOld = (a: string) => task.oldAliases.includes(a);
  const norm = (v: unknown) => String(v ?? "").trim().toUpperCase();

  for (const c of Array.isArray(raw.create) ? raw.create : []) {
    const entry = (c ?? {}) as { name?: unknown; items?: unknown; why?: unknown };
    const aliases = Array.isArray(entry.items) ? entry.items.map(norm) : [];
    const name = String(entry.name ?? "").trim().replace(/["「」]/g, "").slice(0, MAX_BUNDLE_NAME);
    const unique = new Set(aliases);
    if (
      aliases.length < 2 ||
      unique.size !== aliases.length ||
      !aliases.every((a) => (isNew(a) || isOld(a)) && !used.has(a)) ||
      !aliases.some(isNew) ||
      name.length < 2 ||
      BANNED_NAMES.some((b) => name.includes(b))
    ) {
      out.dropped.push(`开新捆「${name}」${aliases.join("、")}`);
      continue;
    }
    // 一捆一个项目（2026-10-27）：读条员认出的项目有两样以上，就不让捆（认不出的不算数）。
    if (new Set(aliases.map((a) => task.projects.get(a)).filter(Boolean)).size > 1) {
      out.dropped.push(`开新捆「${name}」${aliases.join("、")}（项目不一样）`);
      continue;
    }
    aliases.forEach((a) => used.add(a));
    out.creates.push({ name, ids: aliases.map((a) => task.items.get(a)!), why: cleanWhy(entry.why) });
  }
  for (const j of Array.isArray(raw.join) ? raw.join : []) {
    const entry = (j ?? {}) as { item?: unknown; bundle?: unknown; why?: unknown };
    const a = norm(entry.item);
    const b = norm(entry.bundle);
    if (!isNew(a) || used.has(a) || !task.bundles.has(b)) {
      out.dropped.push(`放进 ${b}：${a}`);
      continue;
    }
    const mine = task.projects.get(a);
    const theirs = task.bundleProjects.get(b);
    if (mine && theirs && theirs.size && !theirs.has(mine)) { // 这条的项目跟这捆里哪条都对不上，不让放
      out.dropped.push(`放进 ${b}：${a}（项目不一样）`);
      continue;
    }
    used.add(a);
    out.joins.push({ id: task.items.get(a)!, bundleId: task.bundles.get(b)!, why: cleanWhy(entry.why) });
  }
  return out;
}

// ── 检查的题：每组所有能挪的条目（捆里的、散着的，不管谁捆的），编号 I1…，捆 B1… ──

export interface CheckTask {
  label: string;
  /** 短号 → 真条目 id */
  items: Map<string, string>;
  /** 短号 → 真捆号 */
  bundles: Map<string, string>;
  /** 条目短号 → 它现在在哪个捆的短号（散着没有） */
  where: Map<string, string>;
  bundleNames: Map<string, string>;
  text: string;
}

/** 有人在干、写了报告的不检查（挪了会搅乱正在干活的 AI）。 */
function checkable(r: BookmarkRecord): boolean {
  return !r.claimedBy && !r.report;
}

export function buildCheckTask(group: OrganizerGroup, opts: { meta: Record<string, BundleMeta>; openBundle: (bundleId: string) => boolean; notes?: NoteBook }): CheckTask | null {
  const bundleIds = [...new Set(group.records.map((r) => r.bundleId).filter((b): b is string => Boolean(b)))].filter(opts.openBundle);
  if (!bundleIds.length) return null; // 没有捆，就没有「放错」可言
  const items = new Map<string, string>();
  const bundles = new Map<string, string>();
  const where = new Map<string, string>();
  const bundleNames = new Map<string, string>();
  const lines: string[] = [`分组：${group.label}`, "", "【捆】"];
  let n = 0;
  bundleIds.forEach((bid, i) => {
    const alias = `B${i + 1}`;
    bundles.set(alias, bid);
    const members = group.records.filter((r) => r.bundleId === bid);
    const name = opts.meta[bid]?.name ?? cleanText(members[0], 16);
    bundleNames.set(alias, name);
    lines.push(`${alias}「${name}」，里面有：`);
    for (const m of members) {
      n += 1;
      const ia = `I${n}`;
      items.set(ia, m.id);
      where.set(ia, alias);
      lines.push(`  ${ia} ${lineOf(m, opts.notes, 120)}`);
    }
  });
  const loose = group.records.filter((r) => !r.bundleId && checkable(r));
  lines.push("", "【散着的条目】");
  if (!loose.length) lines.push("（没有）");
  for (const r of loose) {
    n += 1;
    const ia = `I${n}`;
    items.set(ia, r.id);
    lines.push(`${ia} ${lineOf(r, opts.notes, 120)}`);
  }
  return { label: group.label, items, bundles, where, bundleNames, text: lines.join("\n") };
}

export interface CleanHint {
  itemId: string;
  /** 建议放进的捆；null＝建议散着（不属于现在这捆）。 */
  toBundle: string | null;
  /** 给人看的一句：可能该在「…」捆 / 可能不属于「…」捆 */
  text: string;
  why: string;
}

export function validateCheck(raw: RawPlan, task: CheckTask): { hints: CleanHint[]; dropped: string[] } {
  const out: CleanHint[] = [];
  const dropped: string[] = [];
  const used = new Set<string>();
  for (const h of Array.isArray(raw.hints) ? raw.hints : []) {
    const e = (h ?? {}) as { item?: unknown; to?: unknown; why?: unknown };
    const a = String(e.item ?? "").trim().toUpperCase();
    const toRaw = String(e.to ?? "").trim();
    const to = toRaw.toUpperCase();
    const now = task.where.get(a);
    const toLoose = toRaw === "散着";
    if (!task.items.has(a) || used.has(a) || (!toLoose && !task.bundles.has(to)) || (toLoose && !now) || (!toLoose && now === to)) {
      dropped.push(`提示 ${a} → ${toRaw}`);
      continue;
    }
    used.add(a);
    out.push({
      itemId: task.items.get(a)!,
      toBundle: toLoose ? null : task.bundles.get(to)!,
      text: toLoose ? `可能不属于「${task.bundleNames.get(now!)}」捆` : `可能该在「${task.bundleNames.get(to)}」捆`,
      why: cleanWhy(e.why),
    });
  }
  return { hints: out, dropped };
}

// ── 提示本（AI整理提示.json）：挂在哪条、条目当时在哪（挪了就作废）、用户点过「知道了」的 ──

export interface HintEntry {
  itemId: string;
  /** 出提示时条目在哪：捆号，散着是 "loose"。条目挪了地方，这条提示就作废。 */
  placement: string;
  text: string;
  why: string;
  at: string;
}

export interface HintBook {
  hints: HintEntry[];
  /** 点过「知道了」：这条只要还在这个位置，就不再提示。 */
  dismissed: { itemId: string; placement: string }[];
  /** 每组上次检查时看板长什么样（指纹）。没变就不再花钱查。 */
  checked: Record<string, string>;
}

export function placementOf(r: BookmarkRecord): string {
  return r.bundleId ?? "loose";
}

export function parseHintBook(raw: unknown): HintBook {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const hints = (Array.isArray(r.hints) ? r.hints : [])
    .map((h) => (h ?? {}) as Record<string, unknown>)
    .filter((h) => str(h.itemId) && str(h.placement) && str(h.text))
    .map((h) => ({ itemId: str(h.itemId), placement: str(h.placement), text: str(h.text), why: str(h.why), at: str(h.at) }));
  const dismissed = (Array.isArray(r.dismissed) ? r.dismissed : [])
    .map((d) => (d ?? {}) as Record<string, unknown>)
    .filter((d) => str(d.itemId) && str(d.placement))
    .map((d) => ({ itemId: str(d.itemId), placement: str(d.placement) }));
  const checked: Record<string, string> = {};
  if (r.checked && typeof r.checked === "object") for (const [k, v] of Object.entries(r.checked)) if (typeof v === "string") checked[k] = v;
  return { hints, dismissed, checked };
}

/** 只留还作数的：条目删了、挪了地方的提示和「知道了」一起清掉（用户：干完的不留账）。 */
export function liveHintBook(book: HintBook, records: BookmarkRecord[]): HintBook {
  const at = new Map(records.map((r) => [r.id, placementOf(r)]));
  const ok = (x: { itemId: string; placement: string }) => at.get(x.itemId) === x.placement;
  return { hints: book.hints.filter(ok), dismissed: book.dismissed.filter(ok), checked: { ...book.checked } };
}

/** 一组现在长什么样：条目、在哪、写的啥。挪了一条、来了一条、改了字，指纹就变。 */
export function groupFingerprint(group: OrganizerGroup): string {
  let h = 2166136261;
  const s = group.records.map((r) => `${r.id}|${r.bundleId ?? ""}|${r.text}|${r.claimedBy ?? ""}|${r.report ? 1 : 0}`).join("\n");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${group.records.length}-${h.toString(36)}`;
}

// ── 整理记录（AI整理记录.json）：一次一条，一行一件事；理由放气泡里 ──

export type RowAction = "开新捆" | "放进" | "改捆名" | "没动" | "提示" | "没成" | "全部重来" | "撤销重来" | "换模型";

export interface RecordRow {
  group: string;
  action: RowAction;
  /** 一行写改了啥 */
  title: string;
  /** 为什么（鼠标碰到这行冒气泡） */
  why: string;
  itemIds: string[];
}

export interface RunRecord {
  at: string;
  model: string;
  rows: RecordRow[];
}

export function parseRunRecords(raw: unknown): RunRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: RunRecord[] = [];
  for (const v of raw) {
    const r = (v ?? {}) as Record<string, unknown>;
    if (typeof r.at !== "string" || !Array.isArray(r.rows)) continue;
    const rows = r.rows
      .map((x) => (x ?? {}) as Record<string, unknown>)
      .filter((x) => typeof x.title === "string" && typeof x.action === "string")
      .map((x) => ({
        group: String(x.group ?? ""),
        action: x.action as RowAction,
        title: String(x.title),
        why: String(x.why ?? ""),
        itemIds: Array.isArray(x.itemIds) ? x.itemIds.map(String) : [],
      }));
    out.push({ at: r.at, model: String(r.model ?? ""), rows });
  }
  return out;
}

/** 条目都删光了的行去掉，空了的次去掉，最多留 MAX_RUNS 次（新的在前）。 */
export function pruneRunRecords(runs: RunRecord[], aliveIds: Set<string>, max = MAX_RUNS): RunRecord[] {
  return runs
    .map((run) => ({ ...run, rows: run.rows.filter((row) => !row.itemIds.length || row.itemIds.some((id) => aliveIds.has(id))) }))
    .filter((run) => run.rows.length > 0)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, max);
}

// ── 程序卡死的规矩（规矩页只读显示）：直接拿这里的常数拼，跟真执行的永远一样 ──

export function hardRulesText(): string {
  return [
    "这些写在程序里，AI 说什么都越不过去。改它们要跟 AI 说一声改代码。",
    "",
    "管哪些：",
    "- 只整理各 Agent 分组和交接单专区；💭待定区不整理。",
    "- 每组单独问一次 AI。不同组的条目永远捆不到一起（AI 说了也会被程序拦下）。",
    `- 刚写不到 ${Math.round(MIN_AGE_MS / 60000)} 分钟的条目先不整理（你可能还在写）。`,
    "",
    "整理一次（自动整理也是这一套）：",
    "- 先读条目：一条一问，把这条的字、详情、带的每张图都给 AI，让它用大白话写项目名、小标题（50 字起、一般 100 字内，开头点明项目）、小结；读条目规矩一改，每条下一轮按新规矩重读。板上每条第一行显示小标题，原文收起，点小标题展开。",
    "- 读过的条目不再读；改了字、换了图，下一轮重读。刚写的也先不读。",
    `- 读条目时一条最多带 ${MAX_IMAGES_PER_ITEM} 张图，单张超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 不带。`,
    "- 再分捆：拿小卡片出题，不再送原文和原图；没读成的条目退回送原文和原图。",
    "- 分捆只看 AI 没看过的新条目，看过一次就不再看。",
    "- AI 只能做两件事：把新条目放进已有的捆、拿两条以上开一个新捆。不能改字、不能把捆里的拿出来。",
    "- 一捆一个项目：读条目时认出的项目名不一样的，AI 说要捆一起也捆不进去（认不出项目的不拦）。",
    "- 你手动动过的条目（拖进拖出、右键成捆、拆捆）不碰。",
    `- 捆名不许用：${BANNED_NAMES.join("、")}。捆名最长 ${MAX_BUNDLE_NAME} 个字。`,
    "- 捆名全交给 AI：没起过名的捆、条目进出过的捆、里面条目小标题变了的捆，都照各条小标题重写大标题（多人派工捆除外）。没变的不再花钱。",
    "- 你停手 5 分钟（看板 5 分钟没变），自动整理一次：重读改过的条目、分新条目、重写变了的捆名、检查；整理完没再变就不再整理。定时整理照旧，没变化就什么都不做。",
    "- AI 说错的那一条（编号不对、重复、跨组）直接丢掉，不连累同一轮别的。",
    "- 整理完接着检查一遍：整组连你捆的一起看，放错的在条目右边挂小橙点，不挪任何东西。",
    "- 看板上没变化的组不再检查，不花钱。",
    "- 你点了「知道了」的那条，只要还在原地就不再提示；挪了地方，提示和「知道了」一起作废。",
    "",
    "全部重来：",
    "- 所有捆全拆开，你动过的也一样；每条的小标题也清掉重读，然后马上重新整理加检查。",
    "- 有 AI 正在干的、写了报告等你审的、多人派工占住的捆和条目，不拆不碰。",
    "- 重来之前存一份原样；在下一次整理之前，点「撤销重来」能一键回去。",
    "",
    "记账：",
    `- 整理记录最多留 ${MAX_RUNS} 次。条目删掉以后，跟它有关的记录、提示一起删，不攒着。`,
    "- 账本跟着看板现算，条目删了账本里也就没了。",
  ].join("\n");
}

// ── 跑一轮 ──

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GroupResult {
  label: string;
  created: { name: string; ids: string[]; why: string }[];
  joined: { name: string; id: string; text: string; why: string }[];
  skippedIds: string[];
  dropped: string[];
  error?: string;
  /** 这次要处理的新条目（没成时记录挂在它们身上）。 */
  newIds: string[];
}

export interface OrganizeSummary {
  at: string;
  model: string;
  groups: GroupResult[];
  /** 有没有真动了捆。 */
  changed: boolean;
}

export interface RunDeps {
  store: BookmarkStore;
  agents: string[];
  config: OrganizerConfig;
  fetchFn: FetchFn;
  attachmentsDir?: string;
  now?: number;
  minAgeMs?: number;
  timeoutMs?: number;
  /** 用户在设置里改过的整理规矩；不传用默认 ORGANIZER_RULES。 */
  rules?: string;
  /** 读条目写好的小卡片：分捆拿它出题，捆里加了条目拿它重写捆名。 */
  notes?: NoteBook;
}

function dataUrl(file: string): string {
  const ext = extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

/** 对面忙、网断了，隔多久重拨（2026-10-13：全部重来时对面回 524「上游暂时不可用」，程序一次就放弃，整组一捆没捆）。测试里调成 0。 */
export const retryPlan = { delaysMs: [10_000, 30_000] };

/** 这些是对面一时的毛病，过一会儿再拨多半就通：超时、限流、服务器忙、网关断。 */
function transientStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status) || (status >= 520 && status <= 529);
}

/** 打一通能重拨的电话没通：retry＝过一会儿再拨可能就通。 */
class ModelCallError extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 发一次对话。有的家不认 reasoning_effort（回 400），去掉它再试一次；对面一时的毛病，按 retryPlan 隔一会儿再拨。 */
export async function chat(entry: ModelEntry, messages: unknown[], effort: Effort, fetchFn: FetchFn, timeoutMs = 300000, maxTokens = MAX_TOKENS[effort]): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chatOnce(entry, messages, effort, fetchFn, timeoutMs, maxTokens);
    } catch (error) {
      const wait = retryPlan.delaysMs[attempt];
      if (!(error instanceof ModelCallError && error.retry) || wait === undefined) throw error;
      await sleep(wait);
    }
  }
}

async function chatOnce(entry: ModelEntry, messages: unknown[], effort: Effort, fetchFn: FetchFn, timeoutMs: number, maxTokens: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const send = async (withEffort: boolean) => {
    try {
      return await fetchFn(`${entry.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.apiKey}` },
        body: JSON.stringify({
          model: entry.model,
          messages,
          // 先思考再答的模型：上限按档位给足（2026-10-12 实测上限 4000 全被思考吃光、正文为空）。
          max_tokens: maxTokens,
          ...(withEffort ? { reasoning_effort: effort } : {}),
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // 等满了还没回（超时）不重拨，直接换下一个模型；网断了这类过会儿再拨。
      if (controller.signal.aborted) throw new ModelCallError(`模型 ${Math.round(timeoutMs / 1000)} 秒没回`, false);
      throw new ModelCallError(`连不上模型接口：${error instanceof Error ? error.message : error}`, true);
    }
  };
  try {
    let res = await send(true);
    let body = await res.text();
    if (!res.ok && res.status === 400 && /reason|effort|unknown|unsupported|unrecognized|extra|parameter/i.test(body)) {
      res = await send(false);
      body = await res.text();
    }
    if (!res.ok) throw new ModelCallError(`模型接口回 ${res.status}：${body.slice(0, 200)}`, transientStatus(res.status));
    let json: { choices?: { message?: { content?: unknown } }[] };
    try {
      json = JSON.parse(body);
    } catch {
      throw new ModelCallError(`模型接口回的不是正常答复：${body.slice(0, 120)}`, true);
    }
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
    if (!text.trim()) throw new ModelCallError("模型回了空话", true);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 重拨几次还不通的模型，这段时间里别的调用直接跳过它先用备用的，不再一条一条白等。 */
const DOWN_MS = 10 * 60_000;
const downUntil = new Map<string, number>();
/** 这轮换过哪些模型（给整理记录用），takeModelSwitches 取走就清。 */
const switches: string[] = [];

const modelKey = (m: ModelEntry) => `${m.baseUrl}|${m.model}`;

export function takeModelSwitches(): string[] {
  return switches.splice(0);
}

export function resetModelHealth(): void {
  downUntil.clear();
  switches.length = 0;
}

/** 先用选中的模型；不通就按设置里的顺序换下一个有钥匙的（2026-10-13 用户拍板：主模型不通自动换备用的）。 */
export async function chatAny(config: OrganizerConfig, messages: unknown[], fetchFn: FetchFn, timeoutMs = 300000): Promise<string> {
  const first = activeModel(config);
  const order = [first, ...config.models.filter((m) => m.id !== first.id)].filter((m) => m.apiKey);
  const now = Date.now();
  const alive = order.filter((m) => (downUntil.get(modelKey(m)) ?? 0) <= now);
  let lastError: unknown = new Error("还没填模型钥匙");
  for (const m of alive.length ? alive : order) {
    try {
      const text = await chat(m, messages, config.effort, fetchFn, timeoutMs);
      downUntil.delete(modelKey(m));
      if (m.id !== first.id) {
        const note = `「${modelLabel(first)}」不通，改用「${modelLabel(m)}」`;
        if (!switches.includes(note)) switches.push(note);
      }
      return text;
    } catch (error) {
      lastError = error;
      downUntil.set(modelKey(m), Date.now() + DOWN_MS);
    }
  }
  throw lastError;
}

/** 问一次要 JSON 的：回来的读不懂（格式坏了、不合规矩），当场再问一次，不留到下一轮。 */
export async function askJson<T>(config: OrganizerConfig, messages: unknown[], fetchFn: FetchFn, timeoutMs: number | undefined, read: (text: string) => T): Promise<T> {
  const text = await chatAny(config, messages, fetchFn, timeoutMs);
  try {
    return read(text);
  } catch {
    return read(await chatAny(config, messages, fetchFn, timeoutMs));
  }
}

/** 分捆：一组一问，回来的过一遍筛；读不懂当场再问一次。 */
export async function askModel(task: GroupTask, config: OrganizerConfig, fetchFn: FetchFn, timeoutMs = 300000, rules = ORGANIZER_RULES): Promise<CleanPlan> {
  const parts: unknown[] = [{ type: "text", text: task.text }];
  for (const img of task.images) {
    try {
      const url = dataUrl(img.file);
      parts.push({ type: "text", text: `下面这张图属于 ${img.alias}` }, { type: "image_url", image_url: { url } });
    } catch {
      // 读不了的图跳过。
    }
  }
  return askJson(config, [
    { role: "system", content: rules },
    { role: "user", content: parts.length === 1 ? task.text : parts },
  ], fetchFn, timeoutMs, (text) => validatePlan(parsePlanText(text), task));
}

/** 读一条：字＋详情＋它带的每张图，一问一答。projects＝看板上别的条目已经认出的项目名，让它照抄同一个写法。 */
export async function askItemNote(r: BookmarkRecord, config: OrganizerConfig, fetchFn: FetchFn, attachmentsDir?: string, timeoutMs = 300000, rules = ITEM_RULES, projects: string[] = []): Promise<ItemNote> {
  const task = buildItemTask(r, attachmentsDir, projects);
  const parts: unknown[] = [{ type: "text", text: task.text }];
  task.images.forEach((file, i) => {
    try {
      parts.push({ type: "text", text: `[图${i + 1}]` }, { type: "image_url", image_url: { url: dataUrl(file) } });
    } catch {
      // 读不了的图跳过。
    }
  });
  return askJson(config, [
    { role: "system", content: rules },
    { role: "user", content: parts.length === 1 ? task.text : parts },
  ], fetchFn, timeoutMs, (text) => parseItemNote(text, noteKey(r)));
}

export interface NoteDeps {
  store: BookmarkStore;
  agents: string[];
  config: OrganizerConfig;
  fetchFn: FetchFn;
  book: NoteBook;
  attachmentsDir?: string;
  timeoutMs?: number;
  rules?: string;
  now?: number;
  minAgeMs?: number;
  /** 读完一条就叫一声（存盘、刷新看板上的小标题）。 */
  onNote?: (book: NoteBook) => void;
}

export interface NoteResult {
  book: NoteBook;
  read: number;
  /** 没读成的：条目 id ＋ 为什么 */
  errors: { id: string; error: string }[];
}

/** 读条目：该读的一条一条读，同时最多读 NOTE_CONCURRENCY 条。读不成的这轮跳过，下一轮再读。 */
export async function runItemNotes(deps: NoteDeps): Promise<NoteResult> {
  const records = deps.store.list();
  const book = liveNoteBook(deps.book, records);
  const result: NoteResult = { book, read: 0, errors: [] };
  if (!activeModel(deps.config).apiKey) throw new Error("还没填模型钥匙");
  needRules();
  const queue = recordsNeedingNotes(records, deps.agents, book, deps.now ?? Date.now(), deps.minAgeMs);
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        book[r.id] = await askItemNote(r, deps.config, deps.fetchFn, deps.attachmentsDir, deps.timeoutMs, deps.rules?.trim() || ITEM_RULES, knownProjects(book));
        result.read += 1;
        deps.onNote?.(book);
      } catch (error) {
        result.errors.push({ id: r.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: NOTE_CONCURRENCY }, worker));
  return result;
}

/** 捆里加了条目：照各条小卡片重写捆标题。 */
export async function askBundleName(members: BookmarkRecord[], notes: NoteBook | undefined, config: OrganizerConfig, fetchFn: FetchFn, timeoutMs = 300000): Promise<string> {
  const text = ["这一捆里有：", ...members.map((m, i) => `${i + 1}. ${lineOf(m, notes, 160)}`)].join("\n");
  return askJson(config, [
    { role: "system", content: BUNDLE_NAME_RULES },
    { role: "user", content: text },
  ], fetchFn, timeoutMs, (reply) => {
    const raw = parsePlanText(reply) as { name?: unknown };
    const name = String(raw.name ?? "").trim().replace(/["「」]/g, "").slice(0, MAX_BUNDLE_NAME);
    if (name.length < 2 || BANNED_NAMES.some((b) => name.includes(b))) throw new Error(`捆名不合规矩：${name || "空的"}`);
    return name;
  });
}

// ── 捆标题（2026-10-13 用户：捆名全交给 AI，我不手动改；捆里的条目变了、条目内容变了，大标题就重写）──

/** 捆标题账本：捆号 → 起名时这捆里有哪些条、各条小标题是啥（指纹）。指纹没变就不再花钱起名。存 AI捆标题.json。 */
export type NameBook = Record<string, string>;

export function parseNameBook(raw: unknown): NameBook {
  const out: NameBook = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

function bundleSig(members: BookmarkRecord[], notes: NoteBook | undefined): string {
  return fnv(members.map((m) => `${m.id}|${freshNote(m, notes)?.title ?? m.text}`).join("\n"));
}

export interface NameDeps {
  store: BookmarkStore;
  agents: string[];
  config: OrganizerConfig;
  fetchFn: FetchFn;
  notes?: NoteBook;
  book: NameBook;
  timeoutMs?: number;
}

/** 给变了的捆重写大标题：没起过名的、条目进出过的、条目小标题变了的。多人派工捆的名字归派工那边，不碰。 */
export async function runBundleNames(deps: NameDeps): Promise<{ book: NameBook; rows: RecordRow[]; errors: string[] }> {
  needRules();
  const { store } = deps;
  const records = store.list();
  const meta = store.bundleMeta();
  const book: NameBook = {};
  const rows: RecordRow[] = [];
  const errors: string[] = [];
  for (const group of groupsForOrganizer(records, deps.agents)) {
    const ids = [...new Set(group.records.map((r) => r.bundleId).filter((b): b is string => Boolean(b)))];
    for (const bid of ids) {
      const members = group.records.filter((r) => r.bundleId === bid);
      if (members.length < 2 || !store.aiCanName(bid)) continue;
      const sig = bundleSig(members, deps.notes);
      if (deps.book[bid] === sig && meta[bid]) {
        book[bid] = sig;
        continue;
      }
      try {
        const name = await askBundleName(members, deps.notes, deps.config, deps.fetchFn, deps.timeoutMs);
        const before = meta[bid]?.name;
        if (store.aiNameBundle(bid, name)) {
          book[bid] = sig;
          if (name !== before) rows.push({ group: group.label, action: "改捆名", title: before ? `「${before}」改名「${name}」` : `给捆起名「${name}」`, why: "捆里的条目或它们的小标题变了，大标题跟着重写", itemIds: members.map((m) => m.id) });
        }
      } catch (error) {
        errors.push(`${group.label}：${error instanceof Error ? error.message : error}`);
      }
    }
  }
  return { book, rows, errors };
}

/** 整块看板的指纹：条目、字、详情、图、在哪个组哪个捆。闲了 5 分钟、指纹跟上次整理完不一样才再整理。 */
export function boardFingerprint(records: BookmarkRecord[]): string {
  return fnv(records.map((r) => `${r.id}|${r.assignee ?? ""}|${r.bundleId ?? ""}|${r.text}|${r.detail ?? ""}|${r.attachments.join(",")}`).join("\n"));
}

/** 「测一下」：发一句最短的话，回得来就算通。 */
export async function testModel(entry: ModelEntry, fetchFn: FetchFn, timeoutMs = 90000): Promise<string> {
  const text = await chat(entry, [{ role: "user", content: "只回一个字：好" }], "low", fetchFn, timeoutMs, 2000);
  return text.trim().slice(0, 40);
}

export async function runOrganizer(deps: RunDeps): Promise<OrganizeSummary> {
  const { store, config } = deps;
  const entry = activeModel(config);
  const summary: OrganizeSummary = { at: new Date(deps.now ?? Date.now()).toISOString(), model: modelLabel(entry), groups: [], changed: false };
  if (!entry.apiKey) throw new Error("还没填模型钥匙");
  needRules();
  for (const group of groupsForOrganizer(store.list(), deps.agents)) {
    const task = buildGroupTask(group, {
      meta: store.bundleMeta(),
      openBundle: (id) => store.aiOpenBundle(id),
      now: deps.now ?? Date.now(),
      minAgeMs: deps.minAgeMs,
      attachmentsDir: deps.attachmentsDir,
      notes: deps.notes,
    });
    if (!task) continue;
    const newIds = task.newAliases.map((a) => task.items.get(a)!);
    const result: GroupResult = { label: group.label, created: [], joined: [], skippedIds: [], dropped: [], newIds };
    summary.groups.push(result);
    let plan: CleanPlan;
    try {
      plan = await askModel(task, config, deps.fetchFn, deps.timeoutMs, deps.rules?.trim() || ORGANIZER_RULES);
    } catch (error) {
      // 模型没回好：这组这次不算看过，下一轮再试。
      result.error = error instanceof Error ? error.message : String(error);
      continue;
    }
    result.dropped = plan.dropped;
    const touched = new Set<string>();
    for (const c of plan.creates) {
      try {
        const id = store.aiCreateBundle(c.ids, c.name);
        result.created.push({ name: store.bundleMeta()[id]?.name ?? c.name, ids: c.ids, why: c.why });
        c.ids.forEach((x) => touched.add(x));
      } catch (error) {
        result.dropped.push(`开新捆「${c.name}」没成：${error instanceof Error ? error.message : error}`);
      }
    }
    for (const j of plan.joins) {
      try {
        store.aiJoinBundle(j.id, j.bundleId);
        const rec = store.list().find((r) => r.id === j.id);
        const members = store.list().filter((r) => r.bundleId === j.bundleId);
        result.joined.push({ name: store.bundleMeta()[j.bundleId]?.name ?? cleanText(members[0], 16), id: j.id, text: rec ? shortText(rec) : "", why: j.why });
        touched.add(j.id);
      } catch (error) {
        result.dropped.push(`放进捆没成：${error instanceof Error ? error.message : error}`);
      }
    }
    result.skippedIds = newIds.filter((id) => !touched.has(id));
    if (touched.size) summary.changed = true;
    store.markSorted(task.seenIds);
  }
  return summary;
}

/** 整理这一轮写成记录的行。 */
export function organizeRows(s: OrganizeSummary, records: BookmarkRecord[]): RecordRow[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const rows: RecordRow[] = [];
  for (const g of s.groups) {
    if (g.error) {
      rows.push({ group: g.label, action: "没成", title: `${g.newIds.length} 条新条目没整理成，下一轮再试`, why: g.error, itemIds: g.newIds });
      continue;
    }
    for (const c of g.created) rows.push({ group: g.label, action: "开新捆", title: `开新捆「${c.name}」${c.ids.length} 条`, why: c.why || "AI 没写理由", itemIds: c.ids });
    for (const j of g.joined) rows.push({ group: g.label, action: "放进", title: `「${j.text}」→ 放进「${j.name}」`, why: j.why || "AI 没写理由", itemIds: [j.id] });
    if (g.skippedIds.length) {
      const names = g.skippedIds.map((id) => byId.get(id)).filter((r): r is BookmarkRecord => Boolean(r)).map((r) => `「${shortText(r, 12)}」`);
      rows.push({ group: g.label, action: "没动", title: `${g.skippedIds.length} 条先散着：${names.slice(0, 3).join("")}${names.length > 3 ? "…" : ""}`, why: "AI 没找到讲同一个项目的伙伴，或者认不出是哪个项目", itemIds: g.skippedIds });
    }
  }
  return rows;
}

/** 一句话给看板弹提示。 */
export function shortSummary(s: OrganizeSummary): string {
  const created = s.groups.reduce((n, g) => n + g.created.length, 0);
  const joined = s.groups.reduce((n, g) => n + g.joined.length, 0);
  const failed = s.groups.filter((g) => g.error);
  if (!s.groups.length) return "没有新条目要整理";
  const parts: string[] = [];
  if (created) parts.push(`开了 ${created} 个新捆`);
  if (joined) parts.push(`${joined} 条放进了已有的捆`);
  if (!created && !joined && !failed.length) parts.push("看过了，没有要捆的");
  if (failed.length) parts.push(`${failed.map((g) => g.label).join("、")} 没整理成（${failed[0].error}）`);
  return `AI 整理：${parts.join("，")}`;
}

// ── 检查一轮：整组看，挑放错的挂提示，一条都不挪 ──

export interface CheckDeps {
  store: BookmarkStore;
  agents: string[];
  config: OrganizerConfig;
  fetchFn: FetchFn;
  book: HintBook;
  timeoutMs?: number;
  rules?: string;
  now?: number;
  notes?: NoteBook;
}

export interface CheckResult {
  book: HintBook;
  rows: RecordRow[];
  /** 这次真问了几组 */
  checkedGroups: number;
  newHints: number;
  errors: string[];
}

export async function runChecker(deps: CheckDeps): Promise<CheckResult> {
  const { store, config } = deps;
  const entry = activeModel(config);
  const records = store.list();
  const book = liveHintBook(deps.book, records);
  const result: CheckResult = { book, rows: [], checkedGroups: 0, newHints: 0, errors: [] };
  if (!entry.apiKey) throw new Error("还没填模型钥匙");
  needRules();
  const at = new Date(deps.now ?? Date.now()).toISOString();
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const group of groupsForOrganizer(records, deps.agents)) {
    const fp = groupFingerprint(group);
    if (book.checked[group.label] === fp) continue;
    const task = buildCheckTask(group, { meta: store.bundleMeta(), openBundle: (id) => store.aiOpenBundle(id), notes: deps.notes });
    const inGroup = new Set(group.records.map((r) => r.id));
    if (!task) {
      book.hints = book.hints.filter((h) => !inGroup.has(h.itemId));
      book.checked[group.label] = fp;
      continue;
    }
    result.checkedGroups += 1;
    let clean: { hints: CleanHint[]; dropped: string[] };
    try {
      clean = await askJson(config, [{ role: "system", content: deps.rules?.trim() || CHECK_RULES }, { role: "user", content: task.text }], deps.fetchFn, deps.timeoutMs,
        (text) => validateCheck(parsePlanText(text), task));
    } catch (error) {
      result.errors.push(`${group.label}：${error instanceof Error ? error.message : error}`);
      continue; // 没查成不记指纹，下一轮再查
    }
    // 这组的旧提示全换成这次的；点过「知道了」的不再挂。
    book.hints = book.hints.filter((h) => !inGroup.has(h.itemId));
    for (const h of clean.hints) {
      const rec = byId.get(h.itemId);
      if (!rec) continue;
      const placement = placementOf(rec);
      if (book.dismissed.some((d) => d.itemId === h.itemId && d.placement === placement)) continue;
      book.hints.push({ itemId: h.itemId, placement, text: h.text, why: h.why, at });
      result.newHints += 1;
      result.rows.push({ group: group.label, action: "提示", title: `「${shortText(rec)}」${h.text}`, why: h.why || "AI 没写理由", itemIds: [h.itemId] });
    }
    book.checked[group.label] = fp;
  }
  return result;
}

// ── 账本（设定21）：AI 看过哪些、没看过哪些、哪些是用户动过的。跟着看板现算，条目干完删掉，账本里也就没了 ──

export type LedgerState = "没看过" | "看过" | "你动过" | "在干" | "待审";

export interface LedgerGroup {
  label: string;
  counts: Record<LedgerState, number>;
  bundles: { name: string; by: "user" | "ai"; count: number }[];
  items: { text: string; state: LedgerState; bundle: string | null }[];
}

export interface Ledger {
  month: string;
  runsThisMonth: number;
  lastRun: string | null;
  groups: LedgerGroup[];
}

export function ledgerState(r: BookmarkRecord): LedgerState {
  if (r.report) return "待审";
  if (r.claimedBy) return "在干";
  if (r.userPinned) return "你动过";
  return r.sortedAt ? "看过" : "没看过";
}

function clock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** runs 是整理记录（新的在前）：数本月几次、最近一次是什么时候。 */
export function buildLedger(records: BookmarkRecord[], agents: string[], meta: Record<string, BundleMeta>, runs: RunRecord[], now = Date.now()): Ledger {
  const d = new Date(now);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const groups = groupsForOrganizer(records, agents).map((g) => {
    const counts: Record<LedgerState, number> = { 没看过: 0, 看过: 0, 你动过: 0, 在干: 0, 待审: 0 };
    const names = new Map<string, string>();
    const items = g.records.map((r) => {
      const state = ledgerState(r);
      counts[state] += 1;
      let bundle: string | null = null;
      if (r.bundleId) {
        if (!names.has(r.bundleId)) names.set(r.bundleId, meta[r.bundleId]?.name ?? cleanText(r, 16));
        bundle = names.get(r.bundleId)!;
      }
      return { text: shortText(r, 40), state, bundle };
    });
    const bundles = [...names.entries()].map(([id, name]) => ({
      name, by: meta[id]?.by ?? "user", count: g.records.filter((r) => r.bundleId === id).length,
    }));
    return { label: g.label, counts, bundles, items };
  });
  const sorted = [...runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const last = sorted[0] ? `${clock(sorted[0].at)} · ${sorted[0].model}` : null;
  return { month, runsThisMonth: sorted.filter((r) => clock(r.at).startsWith(month)).length, lastRun: last, groups };
}
