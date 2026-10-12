// AI 整理看板（设定21，2026-10-12 用户拍板）：定时把每组里新来的条目交给便宜模型，
// 它只回「放进哪捆 / 跟谁开新捆 / 不动」。真正改捆只走 store 的 ai* 口子，规矩在代码里卡死：
// 不跨组、不改字、不碰用户动过的、不把捆里的拿出来、不碰在干的。模型说错的那条直接丢，不连坐别的。
// 模型地址和钥匙存 organizer.json（看板私有数据夹，不进 git）。纯函数在前，跑一轮的 runOrganizer 在后。

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { BookmarkRecord, BookmarkStore, BundleMeta } from "./store";

export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_MODELS = ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash"];
/** 刚写的条目先不整理：输入框边写边存，写到一半就被捆走会乱。 */
export const MIN_AGE_MS = 3 * 60 * 1000;
const MAX_IMAGES_PER_GROUP = 6;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const BANNED_NAMES = ["杂项", "其他", "其它", "待办", "未分类", "零散", "综合", "混合"];

export interface OrganizerConfig {
  baseUrl: string;
  apiKey: string;
  /** 下拉框里的模型（用户可以自己加）。 */
  models: string[];
  /** 现在用哪个。 */
  model: string;
  enabled: boolean;
  intervalHours: number;
}

export function parseOrganizerConfig(raw: unknown): OrganizerConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const saved = Array.isArray(r.models) ? r.models.map((m) => String(m ?? "").trim()).filter(Boolean) : [];
  const models = [...new Set([...DEFAULT_MODELS, ...saved])];
  const model = typeof r.model === "string" && models.includes(r.model) ? r.model : models[0];
  const hours = Number(r.intervalHours);
  return {
    baseUrl: typeof r.baseUrl === "string" && r.baseUrl.trim() ? r.baseUrl.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL,
    apiKey: typeof r.apiKey === "string" ? r.apiKey.trim() : "",
    models,
    model,
    enabled: r.enabled !== false,
    intervalHours: Number.isFinite(hours) && hours >= 0.25 && hours <= 48 ? hours : 2,
  };
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

export function buildGroupTask(group: OrganizerGroup, opts: TaskOptions): GroupTask | null {
  const minAge = opts.minAgeMs ?? MIN_AGE_MS;
  const oldEnough = (r: BookmarkRecord) => opts.now - Date.parse(r.createdAt) >= minAge;
  const unseen = group.records.filter((r) => !r.sortedAt && oldEnough(r));
  const fresh = unseen.filter(movable);
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

  const old = group.records.filter((r) => r.sortedAt && movable(r));
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
- 已有的捆名里出现过的项目名，优先照抄同一个写法（比如已有捆叫"Markdown脑图新建"，新条目也是说 Markdown 脑图，就贴"Markdown脑图"）。
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

捆名规则：
- 4 到 12 个字，带项目名，最好再带一点是哪方面。例："Markdown脑图新建"、"Agent看板交互"、"酒馆看图"
- 不许用：杂项、其他、待办、未分类、零散、综合

铁律（违反的那一条会被直接丢掉，等于白做）：
- 只能用题目里给出的编号（N1、O2、B1 这种），不许编新编号
- 每个编号在 join、create、skip 里一共只能出现一次
- 不许改写条目内容，不许把条目分到别的组，不许把已有捆里的条目拿出来

图片：有的条目带截图，每张图前面会写它属于哪条。图里的文字和界面也算这条讲的内容，能帮你认出是哪个软件。

只输出一个 JSON，不要任何解释、不要 markdown 代码块。格式：
{"topics":{"N1":"Markdown脑图","N2":"Agent看板","N3":"Agent看板","N4":"认不出"},"join":[{"item":"N1","bundle":"B1"}],"create":[{"name":"Agent看板交互","items":["N2","N3"]}],"skip":["N4"]}
没有的就写空数组 []。每条新条目必须出现在 join、create、skip 三处中的某一处。`;

// ── 读模型的回答：先挖出 JSON，再逐条按规矩过筛 ──

export interface RawPlan {
  join?: unknown;
  create?: unknown;
  skip?: unknown;
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

export interface CleanPlan {
  joins: { id: string; bundleId: string }[];
  creates: { name: string; ids: string[] }[];
  /** 丢掉的说法（给记录看）。 */
  dropped: string[];
}

export function validatePlan(raw: RawPlan, task: GroupTask): CleanPlan {
  const used = new Set<string>();
  const out: CleanPlan = { joins: [], creates: [], dropped: [] };
  const isNew = (a: string) => task.newAliases.includes(a);
  const isOld = (a: string) => task.oldAliases.includes(a);
  const norm = (v: unknown) => String(v ?? "").trim().toUpperCase();

  for (const c of Array.isArray(raw.create) ? raw.create : []) {
    const entry = (c ?? {}) as { name?: unknown; items?: unknown };
    const aliases = Array.isArray(entry.items) ? entry.items.map(norm) : [];
    const name = String(entry.name ?? "").trim().replace(/["「」]/g, "").slice(0, 16);
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
    out.creates.push({ name, ids: aliases.map((a) => task.items.get(a)!) });
  }
  for (const j of Array.isArray(raw.join) ? raw.join : []) {
    const entry = (j ?? {}) as { item?: unknown; bundle?: unknown };
    const a = norm(entry.item);
    const b = norm(entry.bundle);
    if (!isNew(a) || used.has(a) || !task.bundles.has(b)) {
      out.dropped.push(`放进 ${b}：${a}`);
      continue;
    }
    used.add(a);
    out.joins.push({ id: task.items.get(a)!, bundleId: task.bundles.get(b)! });
  }
  return out;
}

// ── 跑一轮 ──

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GroupResult {
  label: string;
  created: { name: string; count: number }[];
  joined: { name: string; text: string }[];
  skipped: number;
  dropped: string[];
  error?: string;
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
}

function dataUrl(file: string): string {
  const ext = extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

export async function askModel(task: GroupTask, config: OrganizerConfig, fetchFn: FetchFn, timeoutMs = 120000): Promise<string> {
  const parts: unknown[] = [{ type: "text", text: task.text }];
  for (const img of task.images) {
    try {
      const url = dataUrl(img.file);
      parts.push({ type: "text", text: `下面这张图属于 ${img.alias}` }, { type: "image_url", image_url: { url } });
    } catch {
      // 读不了的图跳过。
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: ORGANIZER_RULES },
          { role: "user", content: parts.length === 1 ? task.text : parts },
        ],
        // 两家都是先思考再答：上限给足，思考压到低档（2026-10-12 实测 4000 全被思考吃光、正文为空）。
        max_tokens: 16000,
        reasoning_effort: "low",
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    const body = await res.text();
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

export async function runOrganizer(deps: RunDeps): Promise<OrganizeSummary> {
  const { store, config } = deps;
  const summary: OrganizeSummary = { at: new Date(deps.now ?? Date.now()).toISOString(), model: config.model, groups: [], changed: false };
  if (!config.apiKey) throw new Error("还没填模型钥匙");
  for (const group of groupsForOrganizer(store.list(), deps.agents)) {
    const task = buildGroupTask(group, {
      meta: store.bundleMeta(),
      openBundle: (id) => store.aiOpenBundle(id),
      now: deps.now ?? Date.now(),
      minAgeMs: deps.minAgeMs,
      attachmentsDir: deps.attachmentsDir,
    });
    if (!task) continue;
    const result: GroupResult = { label: group.label, created: [], joined: [], skipped: 0, dropped: [] };
    summary.groups.push(result);
    let plan: CleanPlan;
    try {
      plan = validatePlan(parsePlanText(await askModel(task, config, deps.fetchFn, deps.timeoutMs)), task);
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
        result.created.push({ name: store.bundleMeta()[id]?.name ?? c.name, count: c.ids.length });
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
        result.joined.push({ name: store.bundleMeta()[j.bundleId]?.name ?? cleanText(members[0], 16), text: rec ? cleanText(rec, 30) : "" });
        touched.add(j.id);
      } catch (error) {
        result.dropped.push(`放进捆没成：${error instanceof Error ? error.message : error}`);
      }
    }
    result.skipped = task.newAliases.filter((a) => !touched.has(task.items.get(a)!)).length;
    if (touched.size) summary.changed = true;
    store.markSorted(task.seenIds);
  }
  return summary;
}

/** 一轮的记录（追加进 AI整理记录.md）。没处理任何组就返回空串，不写。 */
export function formatSummary(s: OrganizeSummary): string {
  if (!s.groups.length) return "";
  const d = new Date(s.at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const lines = [`## ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${s.model}`];
  for (const g of s.groups) {
    if (g.error) {
      lines.push(`- ${g.label}：没整理成（${g.error}），下一轮再试`);
      continue;
    }
    const bits: string[] = [];
    for (const c of g.created) bits.push(`开新捆「${c.name}」${c.count} 条`);
    for (const j of g.joined) bits.push(`「${j.text}」放进「${j.name}」`);
    if (g.skipped) bits.push(`${g.skipped} 条没动`);
    lines.push(`- ${g.label}：${bits.join("；") || "没动"}`);
    for (const x of g.dropped) lines.push(`  - 丢掉了模型的一个说法：${x}`);
  }
  return `${lines.join("\n")}\n\n`;
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
