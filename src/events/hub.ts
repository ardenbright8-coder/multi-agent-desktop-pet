import { EventEmitter } from "node:events";
import type {
  AgentEvent,
  DiagnosticsSnapshot,
  HubSnapshot,
  InteractionResponseClaim,
  InteractionResponseInput,
  InteractionSubmitResult,
  SearchHit,
  SearchQuery,
} from "../shared/protocol";
import { normalizeAgentEvent } from "../shared/protocol";
import { createLogger } from "../shared/log";
import { EventIndex } from "./event-index";
import { EventJournal } from "./event-journal";
import { InteractionBroker } from "../interaction/broker";
import { SessionStore } from "./session-store";

interface HubServerInfo {
  running: boolean;
  endpoint: string;
  discoveryPath: string;
  ownerPid: number;
  protocolVersion: number;
}

const log = createLogger("session");

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
  private readonly interactionBroker: InteractionBroker;

  constructor(journalPath: string, serverInfo: HubServerInfo) {
    super();
    this.journal = new EventJournal(journalPath);
    this.serverInfo = serverInfo;
    this.interactionBroker = new InteractionBroker(
      (input) => this.sessions.matchesInteraction(input),
      (input, status, error) => {
        this.sessions.updateInteractionStatus(input, status, error);
        this.emit("snapshot", this.snapshot());
      },
      20_000,
      (input) => {
        // 答案超时没人接：把僵尸待处理事项清掉，面板收起，别再让人点一个永远没反应的旧按钮
        if (this.sessions.expireInteraction(input)) this.emit("snapshot", this.snapshot());
      },
    );
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
      log.出事("收到一条读不懂的事件，已丢弃", raw, "publish");
      return { accepted: false, status: "invalid" };
    }
    log.记(`收到事件 agent=${event.agent} kind=${event.kind} 会话=${event.sessionId}${event.interaction ? ` 待${event.interaction.mode === "question" ? "回答" : "授权"}` : ""}`, "publish");
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

  submitInteractionResponse(input: InteractionResponseInput): Promise<InteractionSubmitResult> {
    const normalized = normalizeInteractionResponse(input);
    if (!normalized) return Promise.resolve({ ok: false, status: "unavailable", message: "回答内容不完整，请重新选择。" });
    return this.interactionBroker.submit(normalized);
  }

  claimInteractionResponse(raw: unknown): InteractionResponseClaim | null {
    const binding = normalizeInteractionBinding(raw);
    if (!binding) return null;
    const source = this.sessions.interactionSource(binding);
    if (!source || source !== binding.sourceInstance) return null;
    return this.interactionBroker.claim(binding);
  }

  completeInteractionResponse(raw: unknown): { completed: boolean } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { completed: false };
    const value = raw as Record<string, unknown>;
    if (typeof value.responseId !== "string" || typeof value.claimToken !== "string" || typeof value.success !== "boolean") return { completed: false };
    return {
      completed: this.interactionBroker.complete(
        value.responseId.slice(0, 200),
        value.claimToken.slice(0, 200),
        value.success,
        typeof value.error === "string" ? value.error : undefined,
      ),
    };
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

function normalizeInteractionBinding(value: unknown): (Pick<InteractionResponseInput, "eventId" | "agent" | "sessionId" | "providerRequestId"> & { sourceInstance: string }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fields = ["eventId", "agent", "sessionId", "providerRequestId", "sourceInstance"] as const;
  if (fields.some((field) => typeof raw[field] !== "string" || !(raw[field] as string).trim())) return null;
  return {
    eventId: (raw.eventId as string).slice(0, 160),
    agent: (raw.agent as string).slice(0, 80),
    sessionId: (raw.sessionId as string).slice(0, 200),
    providerRequestId: (raw.providerRequestId as string).slice(0, 200),
    sourceInstance: (raw.sourceInstance as string).slice(0, 160),
  };
}

function normalizeInteractionResponse(value: unknown): InteractionResponseInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as unknown as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const item = raw[key];
    return typeof item === "string" && item.trim() ? item.slice(0, max) : null;
  };
  const eventId = text("eventId", 160);
  const agent = text("agent", 80);
  const sessionId = text("sessionId", 200);
  const providerRequestId = text("providerRequestId", 200);
  if (!eventId || !agent || !sessionId || !providerRequestId || !Array.isArray(raw.answers) || raw.answers.length > 12) return null;
  const answers = raw.answers.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const answer = item as Record<string, unknown>;
    const promptId = typeof answer.promptId === "string" ? answer.promptId.slice(0, 120) : "";
    const optionIds = Array.isArray(answer.optionIds)
      ? answer.optionIds.filter((id): id is string => typeof id === "string").slice(0, 30).map((id) => id.slice(0, 120))
      : undefined;
    const customText = typeof answer.customText === "string" ? answer.customText.trim().slice(0, 10_000) : undefined;
    return promptId ? { promptId, optionIds, customText: customText || undefined } : null;
  });
  if (answers.some((answer) => !answer)) return null;
  return { eventId, agent, sessionId, providerRequestId, answers: answers as InteractionResponseInput["answers"] };
}
