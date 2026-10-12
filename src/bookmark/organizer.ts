// AI 整理看板（设定21，2026-10-12 用户拍板）：定时把每组里新来的条目交给便宜模型，
// 它只回「放进哪捆 / 跟谁开新捆 / 不动」。真正改捆只走 store 的 ai* 口子，规矩在代码里卡死：
// 不跨组、不改字、不碰用户动过的、不把捆里的拿出来、不碰在干的。模型说错的那条直接丢，不连坐别的。
// 整理完接着「检查」（第四版，2026-10-12 用户：只提示不改）：整组连用户捆的一起看，挑放错的挂小橙点，用户点「知道了」就不再提。
// 模型（哪家地址＋钥匙＋模型名，能加多家）存 organizer.json（看板私有数据夹，不进 git）。纯函数在前，跑一轮的在后。

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { BookmarkRecord, BookmarkStore, BundleMeta } from "./store";

export const DEFAULT_PROVIDER = "Command Code";
export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_MODELS = ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash"];
/** 刚写的条目先不整理：输入框边写边存，写到一半就被捆走会乱。 */
export const MIN_AGE_MS = 3 * 60 * 1000;
const MAX_IMAGES_PER_GROUP = 6;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
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
}

export interface TaskOptions {
  meta: Record<string, BundleMeta>;
  openBundle: (bundleId: string) => boolean;
  now: number;
  minAgeMs?: number;
  attachmentsDir?: string;
  /** 规矩页「AI 每次收到的题目」用：散着的（你动过的也算）都当新条目，好让用户看到题目长什么样。 */
  previewAll?: boolean;
}

function movable(r: BookmarkRecord): boolean {
  return !r.bundleId && !r.userPinned && !r.claimedBy && !r.report;
}

export function cleanText(record: BookmarkRecord, limit = 300): string {
  let t = record.text.replace(/\[图片:[^\]]*\]/g, "[图]").replace(/\s+/g, " ").trim();
  if (t.length > limit) t = `${t.slice(0, limit)}…`;
  if (record.kind === "handoff") t = `（交接单）${t}`;
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

export function buildGroupTask(group: OrganizerGroup, opts: TaskOptions): GroupTask | null {
  const minAge = opts.minAgeMs ?? MIN_AGE_MS;
  const oldEnough = (r: BookmarkRecord) => opts.now - Date.parse(r.createdAt) >= minAge;
  const unseen = opts.previewAll ? group.records : group.records.filter((r) => !r.sortedAt && oldEnough(r));
  const fresh = unseen.filter(opts.previewAll ? (r) => !r.bundleId && !r.claimedBy && !r.report : movable);
  if (!fresh.length) return null;
  const items = new Map<string, string>();
  const bundles = new Map<string, string>();
  const lines: string[] = [`分组：${group.label}`, ""];

  const bundleIds = [...new Set(group.records.map((r) => r.bundleId).filter((b): b is string => Boolean(b)))].filter(opts.openBundle);
  lines.push("【已有的捆】（可以把新条目放进去）");
  if (!bundleIds.length) lines.push("（没有）");
  bundleIds.forEach((bid, i) => {
    const alias = `B${i + 1}`;
    bundles.set(alias, bid);
    const members = group.records.filter((r) => r.bundleId === bid);
    const name = opts.meta[bid]?.name ?? cleanText(members[0], 16);
    lines.push(`${alias}「${name}」，里面有：`);
    for (const m of members) lines.push(`  - ${cleanText(m, 120)}`);
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
    lines.push(`${alias} ${cleanText(r, 160)}`);
  });
  lines.push("");

  const images: { alias: string; file: string }[] = [];
  const newAliases: string[] = [];
  lines.push("【新条目】（这次要你处理的，每条都要给结果）");
  fresh.forEach((r, i) => {
    const alias = `N${i + 1}`;
    items.set(alias, r.id);
    newAliases.push(alias);
    let pics = 0;
    if (opts.attachmentsDir) {
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
    lines.push(`${alias} ${cleanText(r)}${pics ? `（带 ${pics} 张图，见下面标着 ${alias} 的图）` : ""}`);
  });

  return { label: group.label, items, bundles, newAliases, oldAliases, seenIds: unseen.map((r) => r.id), text: lines.join("\n"), images };
}

/** 给弱模型的规矩：写得很细、带对错例子、说清每条违规的下场。改这里先跑 organizer 单测。 */
export const ORGANIZER_RULES = `你是看板整理员。用户在一个任务看板里随手记事（多半是语音转的字，错字多、啰嗦），一条一条写得很乱。你的活只有一件：把「新条目」按"讲的是不是同一个项目"归到捆里。

照这三步做：

第一步：给每条新条目贴一个"项目名"标签（写进 topics）。
- 项目名 = 这条说的是哪个软件、哪个工具、哪个项目。2 到 10 个字。
- 已有的捆名里出现过的项目名，优先照抄同一个写法（比如已有捆叫"Markdown脑图：右键新建不显示"，新条目也是说 Markdown 脑图，就贴"Markdown脑图"）。
- 同一个东西只用一种写法：语音转字常把名字说歪，按意思认。例："看板""Agent 看板""桌宠看板""AG 的看板""bookmark-cli 看板命令"都是同一个项目，统一贴"Agent看板"；"酒馆前端""酒馆出图""套餐出图"都贴"酒馆"。
- 实在认不出是哪个项目，贴"认不出"。

第二步：按标签归捆。
- 某条新条目的标签，跟某个已有捆讲的项目一样 → join 放进那个捆。
- 两条以上新条目（或新条目 + 散着的旧条目 O 开头）标签一样，又没有对应的已有捆 → create 开一个新捆，把它们全放进去。
- 标签是"认不出"、或者这个标签只有它一条 → skip。

第三步：检查。每条新条目只能出现在 join、create、skip 其中一处；编号只能用题目里给的。

什么算"同一个项目"：
✅ "Markdown 脑图右键新建不显示" 和 "Markdown 脑图新建以后打不开" → 都是 Markdown脑图
✅ "看板一捆的机制没用起来" 和 "看板 F1 置顶的逻辑" 和 "bookmark-cli 加个读文件的选项" → 都是 Agent看板
❌ "Markdown 脑图右键新建" 和 "库管理面板返回键没反应" → 两个不同的软件，就算都是界面问题也不捆
❌ 只是大类相同不算：都跟 AI 有关、都是改代码、都是界面问题、都是"要做的事"

捆名规则（用户看捆名就要知道这捆是干啥的、好派活）：
- 10 到 20 个字：先写项目名，冒号，再写这捆里最主要的两三件事，用「·」隔开
- 照顾到捆里每一条的主要意思，别只写第一条的；事情多就挑最要紧的三件
- 例："Agent看板：一捆机制·F1置顶·链接显示"、"酒馆：看图对比·套餐出图分开"、"Markdown脑图：右键新建不显示"
- 不许用：杂项、其他、待办、未分类、零散、综合

理由（why）：每个 join、每个 create 都写一句为什么这么归，给用户看的，20 字以内，说人话。例："都在说 Agent 看板的界面"、"讲的是酒馆出图，跟这捆一样"。

铁律（违反的那一条会被直接丢掉，等于白做）：
- 只能用题目里给出的编号（N1、O2、B1 这种），不许编新编号
- 每个编号在 join、create、skip 里一共只能出现一次
- 不许改写条目内容，不许把条目分到别的组，不许把已有捆里的条目拿出来

图片：有的条目带截图，每张图前面会写它属于哪条。图里的文字和界面也算这条讲的内容，能帮你认出是哪个软件。

只输出一个 JSON，不要任何解释、不要 markdown 代码块。格式：
{"topics":{"N1":"Markdown脑图","N2":"Agent看板","N3":"Agent看板","N4":"认不出"},"join":[{"item":"N1","bundle":"B1","why":"都在说 Markdown 脑图"}],"create":[{"name":"Agent看板：一捆机制·F1置顶","items":["N2","N3"],"why":"两条都在说 Agent 看板"}],"skip":["N4"]}
没有的就写空数组 []。每条新条目必须出现在 join、create、skip 三处中的某一处。`;

/** 检查（2026-10-12 用户：放错的给个提示，不改；我还是按我的来）。整组连用户捆的一起看。 */
export const CHECK_RULES = `你是看板检查员。用户的任务看板里，条目按"讲的是不是同一个项目"捆成一捆一捆，有的是用户自己捆的，有的是 AI 捆的，可能有放错的。你的活只有一件：挑出放错的条目，给用户一个提示。你不改任何东西，挪不挪由用户自己决定。

先认项目：每条说的是哪个软件、哪个工具、哪个项目。语音转字常把名字说歪，按意思认。例："看板""Agent 看板""桌宠看板""AG 的看板"都是 Agent看板；"酒馆前端""酒馆出图""套餐出图"都是酒馆。

什么算放错：
- 捆里的某条，讲的项目跟这捆别的条目明显不是同一个 → 放错了。它跟另一个捆是同一个项目，to 写那个捆的编号；跟哪个捆都不是，to 写"散着"。
- 散着的某条，跟某个捆讲的明显是同一个项目 → to 写那个捆的编号。
- 只是大类相同不算同一个项目：都跟 AI 有关、都是改代码、都是界面问题。
- 拿不准的不提。宁可少提，不要乱提：用户每看一条提示都要花工夫。

理由（why）：一句话，20 字以内，说人话。例："讲的是酒馆出图，不是看板"。

铁律（违反的那一条会被直接丢掉）：
- 只能用题目里给出的编号（I1、B1 这种），不许编新编号
- 一条只提一次；to 只能是 B 开头的编号或"散着"
- 条目已经在 B2 里，就不许 to B2；散着的条目不许 to "散着"

只输出一个 JSON，不要任何解释、不要 markdown 代码块。格式：
{"hints":[{"item":"I3","to":"B2","why":"讲的是酒馆出图，不是看板"},{"item":"I7","to":"散着","why":"跟这捆别的都不是一个软件"}]}
没有放错的就输出 {"hints":[]}。`;

// ── 读模型的回答：先挖出 JSON，再逐条按规矩过筛 ──

export interface RawPlan {
  join?: unknown;
  create?: unknown;
  skip?: unknown;
  hints?: unknown;
}

export function parsePlanText(text: string): RawPlan {
  const body = String(text ?? "").replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没回 JSON");
  const parsed: unknown = JSON.parse(body.slice(start, end + 1));
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
    const name = String(entry.name ?? "").trim().replace(/["「」]/g, "").slice(0, 24);
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

export function buildCheckTask(group: OrganizerGroup, opts: { meta: Record<string, BundleMeta>; openBundle: (bundleId: string) => boolean }): CheckTask | null {
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
      lines.push(`  ${ia} ${cleanText(m, 120)}`);
    }
  });
  const loose = group.records.filter((r) => !r.bundleId && checkable(r));
  lines.push("", "【散着的条目】");
  if (!loose.length) lines.push("（没有）");
  for (const r of loose) {
    n += 1;
    const ia = `I${n}`;
    items.set(ia, r.id);
    lines.push(`${ia} ${cleanText(r, 120)}`);
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

export type RowAction = "开新捆" | "放进" | "没动" | "提示" | "没成" | "全部重来" | "撤销重来";

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
    "- 只看 AI 没看过的新条目，看过一次就不再看。",
    "- AI 只能做两件事：把新条目放进已有的捆、拿两条以上开一个新捆。不能改字、不能把捆里的拿出来。",
    "- 你手动动过的条目（拖进拖出、右键成捆、拆捆）不碰。",
    `- 捆名不许用：${BANNED_NAMES.join("、")}。`,
    `- 每组最多带 ${MAX_IMAGES_PER_GROUP} 张图给 AI，单张超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 不带。`,
    "- AI 说错的那一条（编号不对、重复、跨组）直接丢掉，不连累同一轮别的。",
    "- 整理完接着检查一遍：整组连你捆的一起看，放错的在条目右边挂小橙点，不挪任何东西。",
    "- 看板上没变化的组不再检查，不花钱。",
    "- 你点了「知道了」的那条，只要还在原地就不再提示；挪了地方，提示和「知道了」一起作废。",
    "",
    "全部重来：",
    "- 所有捆全拆开，你动过的也一样，然后马上重新整理加检查。",
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
}

function dataUrl(file: string): string {
  const ext = extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

/** 发一次对话。有的家不认 reasoning_effort（回 400），去掉它再试一次。 */
export async function chat(entry: ModelEntry, messages: unknown[], effort: Effort, fetchFn: FetchFn, timeoutMs = 300000, maxTokens = MAX_TOKENS[effort]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const send = (withEffort: boolean) =>
    fetchFn(`${entry.baseUrl}/chat/completions`, {
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
  try {
    let res = await send(true);
    let body = await res.text();
    if (!res.ok && res.status === 400 && /reason|effort|unknown|unsupported|unrecognized|extra|parameter/i.test(body)) {
      res = await send(false);
      body = await res.text();
    }
    if (!res.ok) throw new Error(`模型接口回 ${res.status}：${body.slice(0, 200)}`);
    const json = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
    if (!text.trim()) throw new Error("模型回了空话");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function askModel(task: GroupTask, config: OrganizerConfig, fetchFn: FetchFn, timeoutMs = 300000, rules = ORGANIZER_RULES): Promise<string> {
  const parts: unknown[] = [{ type: "text", text: task.text }];
  for (const img of task.images) {
    try {
      const url = dataUrl(img.file);
      parts.push({ type: "text", text: `下面这张图属于 ${img.alias}` }, { type: "image_url", image_url: { url } });
    } catch {
      // 读不了的图跳过。
    }
  }
  return chat(activeModel(config), [
    { role: "system", content: rules },
    { role: "user", content: parts.length === 1 ? task.text : parts },
  ], config.effort, fetchFn, timeoutMs);
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
  for (const group of groupsForOrganizer(store.list(), deps.agents)) {
    const task = buildGroupTask(group, {
      meta: store.bundleMeta(),
      openBundle: (id) => store.aiOpenBundle(id),
      now: deps.now ?? Date.now(),
      minAgeMs: deps.minAgeMs,
      attachmentsDir: deps.attachmentsDir,
    });
    if (!task) continue;
    const newIds = task.newAliases.map((a) => task.items.get(a)!);
    const result: GroupResult = { label: group.label, created: [], joined: [], skippedIds: [], dropped: [], newIds };
    summary.groups.push(result);
    let plan: CleanPlan;
    try {
      plan = validatePlan(parsePlanText(await askModel(task, config, deps.fetchFn, deps.timeoutMs, deps.rules?.trim() || ORGANIZER_RULES)), task);
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
  const at = new Date(deps.now ?? Date.now()).toISOString();
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const group of groupsForOrganizer(records, deps.agents)) {
    const fp = groupFingerprint(group);
    if (book.checked[group.label] === fp) continue;
    const task = buildCheckTask(group, { meta: store.bundleMeta(), openBundle: (id) => store.aiOpenBundle(id) });
    const inGroup = new Set(group.records.map((r) => r.id));
    if (!task) {
      book.hints = book.hints.filter((h) => !inGroup.has(h.itemId));
      book.checked[group.label] = fp;
      continue;
    }
    result.checkedGroups += 1;
    let clean: { hints: CleanHint[]; dropped: string[] };
    try {
      const text = await chat(entry, [{ role: "system", content: deps.rules?.trim() || CHECK_RULES }, { role: "user", content: task.text }], config.effort, deps.fetchFn, deps.timeoutMs);
      clean = validateCheck(parsePlanText(text), task);
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
