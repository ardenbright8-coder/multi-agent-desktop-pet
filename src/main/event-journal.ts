import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent } from "../shared/protocol";
import { normalizeAgentEvent } from "../shared/protocol";

const KEEP_EVENTS = 5_000;
const COMPACT_AT = 5_500;

export class EventJournal {
  private events: AgentEvent[] = [];

  constructor(public readonly path: string) {}

  load(): AgentEvent[] {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "", { encoding: "utf8", mode: 0o600 });
      return [];
    }
    let raw = readFileSync(this.path, "utf8");
    if (raw && !raw.endsWith("\n")) {
      const lastBreak = raw.lastIndexOf("\n");
      const tail = raw.slice(lastBreak + 1);
      let tailValid = false;
      try { tailValid = Boolean(normalizeAgentEvent(JSON.parse(tail))); } catch { tailValid = false; }
      if (tailValid) {
        appendFileSync(this.path, "\n", "utf8");
        raw += "\n";
      } else {
        const corruptPath = `${this.path}.corrupt.ndjson`;
        appendFileSync(corruptPath, `${tail}\n`, { encoding: "utf8", mode: 0o600 });
        truncateSync(this.path, Math.max(0, lastBreak + 1));
        raw = raw.slice(0, Math.max(0, lastBreak + 1));
      }
    }
    const loaded: AgentEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = normalizeAgentEvent(JSON.parse(line));
        if (event) loaded.push(event);
      } catch {
        // A partial tail record after a crash is ignored; valid earlier records survive.
      }
    }
    this.events = loaded.slice(-KEEP_EVENTS);
    if (loaded.length > KEEP_EVENTS) this.compact();
    return [...this.events];
  }

  append(event: AgentEvent): string[] {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
      if (event.kind === "permission.requested" || event.kind === "task.completed" || event.kind === "task.failed") {
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
    this.events.push(event);
    let evicted: string[] = [];
    if (this.events.length >= COMPACT_AT || (existsSync(this.path) && statSync(this.path).size > 12 * 1024 * 1024)) {
      evicted = this.events.slice(0, Math.max(0, this.events.length - KEEP_EVENTS)).map((item) => item.eventId);
      this.events = this.events.slice(-KEEP_EVENTS);
      this.compact();
    }
    return evicted;
  }

  all(): AgentEvent[] {
    return [...this.events];
  }

  get count(): number {
    return this.events.length;
  }

  private compact(): void {
    const temp = `${this.path}.${process.pid}.compact.tmp`;
    const body = this.events.map((event) => JSON.stringify(event)).join("\n");
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, body ? `${body}\n` : "", undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
  }
}
