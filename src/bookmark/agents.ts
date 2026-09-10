// Agent 看板的分组清单（看板改版 2026-09-10）：默认四组 + 用户自定义，无限加。
// 🚨 隔离铁律照旧：只认 shared，坏档挪 .corrupt-<时间戳> 存证后用默认组重来，不连坐任何人。

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { bookmarkDataDirectory } from "../shared/paths";

const log = createLogger("bookmark");

export const AGENT_DEFAULTS = ["Claude", "ChatGPT", "Pi Agent", "Hermes"];

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
  private loaded = false;

  constructor(path?: string) {
    this.path = path ?? join(bookmarkDataDirectory(), "agents.json");
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
      return names;
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

  private save(): void {
    writeJsonAtomic(this.path, this.agents);
  }
}
