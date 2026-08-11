import { EventEmitter } from "node:events";
import type { AgentEvent, DiagnosticsSnapshot, HubSnapshot, SearchHit, SearchQuery } from "../shared/protocol";
import { normalizeAgentEvent } from "../shared/protocol";
import { EventIndex } from "./event-index";
import { EventJournal } from "./event-journal";
import { SessionStore } from "./session-store";

interface HubServerInfo {
  running: boolean;
  endpoint: string;
  discoveryPath: string;
  ownerPid: number;
  protocolVersion: number;
}

export class AgentHub extends EventEmitter {
  private readonly journal: EventJournal;
  private readonly index = new EventIndex();
  private sessions = new SessionStore();
  private readonly seenEventIds = new Set<string>();
  private readonly counters = { accepted: 0, duplicate: 0, stale: 0, invalid: 0 };
  private readonly integrationSeenAt = new Map<string, number>();
  private lastAcceptedAt: number | null = null;
  private lastAgent: string | null = null;
  private serverInfo: HubServerInfo;

  constructor(journalPath: string, serverInfo: HubServerInfo) {
    super();
    this.journal = new EventJournal(journalPath);
    this.serverInfo = serverInfo;
    const events = this.journal.load();
    this.index.addAll(events);
    for (const event of events) {
      this.seenEventIds.add(event.eventId);
      this.sessions.apply(event);
      this.integrationSeenAt.set(event.agent, Math.max(this.integrationSeenAt.get(event.agent) || 0, event.emittedAt));
    }
    this.sessions.cleanup();
  }

  updateServerInfo(info: Partial<HubServerInfo>): void {
    this.serverInfo = { ...this.serverInfo, ...info };
  }

  publish(raw: unknown): { accepted: boolean; status: "accepted" | "duplicate" | "stale" | "invalid"; eventId?: string; sequence?: number } {
    const event = normalizeAgentEvent(raw);
    if (!event) {
      this.counters.invalid += 1;
      return { accepted: false, status: "invalid" };
    }
    if (this.seenEventIds.has(event.eventId)) {
      this.counters.duplicate += 1;
      return { accepted: false, status: "duplicate", eventId: event.eventId, sequence: event.sequence };
    }
    const now = Date.now();
    if (event.emittedAt > now + 5 * 60 * 1000 || event.emittedAt < now - 7 * 24 * 60 * 60 * 1000) {
      event.emittedAt = now;
    }
    const result = this.sessions.apply(event);
    if (result === "stale") {
      this.counters.stale += 1;
      return { accepted: false, status: "stale", eventId: event.eventId, sequence: event.sequence };
    }

    let evicted: string[];
    try {
      evicted = this.journal.append(event);
    } catch {
      this.sessions = new SessionStore();
      for (const saved of this.journal.all()) this.sessions.apply(saved);
      this.counters.invalid += 1;
      return { accepted: false, status: "invalid", eventId: event.eventId, sequence: event.sequence };
    }
    for (const eventId of evicted) {
      this.index.remove(eventId);
      this.seenEventIds.delete(eventId);
    }
    this.index.add(event);
    this.seenEventIds.add(event.eventId);
    this.counters.accepted += 1;
    this.lastAcceptedAt = Date.now();
    this.lastAgent = event.agent;
    this.integrationSeenAt.set(event.agent, event.emittedAt);
    const snapshot = this.snapshot();
    this.emit("event", event);
    this.emit("snapshot", snapshot);
    return { accepted: true, status: "accepted", eventId: event.eventId, sequence: event.sequence };
  }

  snapshot(): HubSnapshot {
    return this.sessions.snapshot(this.journal.count);
  }

  search(query: SearchQuery): SearchHit[] {
    const hits = this.index.search(query || {});
    while (hits.length > 1 && Buffer.byteLength(JSON.stringify(hits), "utf8") > 56 * 1024) hits.pop();
    return hits.map((hit) => ({
      ...hit,
      event: { ...hit.event, metadata: undefined, paths: hit.event.paths?.slice(0, 5) },
    }));
  }

  cleanup(): void {
    this.sessions.cleanup();
    this.emit("snapshot", this.snapshot());
  }

  diagnostics(): DiagnosticsSnapshot {
    const now = Date.now();
    const integrations = [
      ["opencode", "OpenCode", "not-seen"],
      ["claude-code", "Claude Code", "not-seen"],
      ["pi", "Pi", "not-seen"],
      ["hermes", "Hermes", "not-seen"],
    ].map(([id, label, fallback]) => {
      const lastSeenAt = this.integrationSeenAt.get(id) || null;
      return {
        id,
        label,
        status: lastSeenAt ? (now - lastSeenAt < 2 * 60 * 1000 ? "connected" : "seen") : fallback === "planned" ? "planned" : "not-seen",
        lastSeenAt,
      } as DiagnosticsSnapshot["integrations"][number];
    });
    return {
      server: { ...this.serverInfo },
      events: {
        ...this.counters,
        lastAcceptedAt: this.lastAcceptedAt,
        lastAgent: this.lastAgent,
      },
      journal: { path: this.journal.path, count: this.journal.count },
      integrations,
    };
  }
}
