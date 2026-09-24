// Agent 看板的分组清单（看板改版 2026-09-10）：默认五组 + 用户自定义，无限加。
// 🚨 隔离铁律照旧：只认 shared，坏档挪 .corrupt-<时间戳> 存证后用默认组重来，不连坐任何人。

import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { bookmarkDataDirectory } from "../shared/paths";

const log = createLogger("bookmark");

// 2026-09-24 加 Antigravity（谷歌反重力），放 Hermes 上面（用户：「多加一个 Agent 放到 Hermes 上面」）。
export const AGENT_DEFAULTS = ["Claude", "ChatGPT", "Pi Agent", "Antigravity", "Hermes"];
/** 加 Antigravity 之前的默认四组：老名单旁边没有 agents-seen.json，就当这四个已经给过。 */
const LEGACY_DEFAULTS = ["Claude", "ChatGPT", "Pi Agent", "Hermes"];

const MAX_AGENTS = 32;
const MAX_NAME_LENGTH = 24;

export interface AgentAddResult {
  list: string[];
  /** 已存在（大小写不敏感）时返回 true，不重复加。 */
  existed: boolean;
}

export class AgentRoster {
  private agents: string[] = [];
  private readonly path: string;
  /** 给过哪些默认组（agents-seen.json）：新默认组只往老名单里补一次，用户删了就不再回来。 */
  private readonly seenPath: string;
  private loaded = false;

  constructor(path?: string) {
    this.path = path ?? join(bookmarkDataDirectory(), "agents.json");
    this.seenPath = join(dirname(this.path), "agents-seen.json");
  }

  list(): string[] {
    this.ensureLoaded();
    return [...this.agents];
  }

  add(rawName: string): AgentAddResult {
    this.ensureLoaded();
    const name = String(rawName ?? "").trim();
    if (!name) throw new Error("Agent 名字不能为空");
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Agent 名字最长 ${MAX_NAME_LENGTH} 个字`);
    const existing = this.find(name);
    if (existing) return { list: [...this.agents], existed: true };
    if (this.agents.length >= MAX_AGENTS) throw new Error(`最多 ${MAX_AGENTS} 个分组，先删几个再加`);
    this.agents.push(name);
    this.save();
    return { list: [...this.agents], existed: false };
  }

  /** 把一个分组挪到另一个分组的上面或下面。名单顺序就是板上的顺序。 */
  move(rawName: string, anchorRaw: string, place: "above" | "below"): string[] {
    this.ensureLoaded();
    const name = this.find(rawName);
    const anchor = this.find(anchorRaw);
    if (!name || !anchor || name === anchor) return this.list();
    const next = this.agents.filter((item) => item !== name);
    let index = next.indexOf(anchor);
    if (place === "below") index += 1;
    next.splice(index, 0, name);
    this.agents = next;
    this.save();
    return this.list();
  }

  /** 移除分组（大小写不敏感）。名下条目的改派由调用方处理，这里只管名单。 */
  remove(rawName: string): boolean {
    this.ensureLoaded();
    const name = String(rawName ?? "").trim();
    if (!name) return false;
    const next = this.agents.filter((item) => item.toLowerCase() !== name.toLowerCase());
    if (next.length === this.agents.length) return false;
    this.agents = next;
    this.save();
    return true;
  }

  /** 名单里有没有这个组（大小写不敏感）。 */
  has(rawName: string): boolean {
    this.ensureLoaded();
    return this.find(rawName) != null;
  }

  private find(name: string): string | null {
    const lower = name.toLowerCase();
    return this.agents.find((item) => item.toLowerCase() === lower) ?? null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.agents = this.loadFromDisk();
    this.loaded = true;
  }

  private loadFromDisk(): string[] {
    if (!existsSync(this.path)) return [...AGENT_DEFAULTS];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("agents.json 顶层不是数组");
      const names = parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, MAX_AGENTS);
      if (!names.length) return [...AGENT_DEFAULTS];
      return this.offerNewDefaults(names);
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.path, backup);
        log.出事("agent 名单读取失败，坏档已存证，用默认四组重来", error, "load");
      } catch {
        log.出事("agent 名单读取失败，且坏档存证也失败", error, "load");
      }
      return [...AGENT_DEFAULTS];
    }
  }

  /** 老名单里补上没给过的默认组：插在默认顺序里它后面那一家的上面（Antigravity → Hermes 上面），后面那几家都不在就放最后；
   *  名单里已经有同名的（大小写不管）不重复。补完记进 agents-seen.json。 */
  private offerNewDefaults(names: string[]): string[] {
    const lower = (s: string) => s.toLowerCase();
    const seen = new Set(this.readSeen().map(lower));
    const fresh = AGENT_DEFAULTS.filter((name) => !seen.has(lower(name)));
    if (!fresh.length) return names;
    const out = [...names];
    for (const name of fresh) {
      if (out.some((item) => lower(item) === lower(name))) continue;
      const after = AGENT_DEFAULTS.slice(AGENT_DEFAULTS.indexOf(name) + 1).map(lower);
      const at = out.findIndex((item) => after.includes(lower(item)));
      if (at < 0) out.push(name);
      else out.splice(at, 0, name);
      log.记(`分组名单补上新默认组「${name}」（只补这一次，删了不再回来）`, "load");
    }
    this.agents = out;
    this.save();
    return out;
  }

  private readSeen(): string[] {
    try {
      if (!existsSync(this.seenPath)) return LEGACY_DEFAULTS;
      const parsed: unknown = JSON.parse(readFileSync(this.seenPath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : LEGACY_DEFAULTS;
    } catch {
      return LEGACY_DEFAULTS;
    }
  }

  private save(): void {
    writeJsonAtomic(this.path, this.agents);
    // 这一版的默认组都算给过了：之后用户删了哪个，重开也不补回来。
    try {
      writeJsonAtomic(this.seenPath, [...new Set([...this.readSeen(), ...AGENT_DEFAULTS])]);
    } catch (error) {
      log.出事("agents-seen.json 写盘失败（最多下回重开再补一次新默认组）", error, "save");
    }
  }
}
