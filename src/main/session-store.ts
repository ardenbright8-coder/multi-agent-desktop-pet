import type { AgentEvent, HubSnapshot, SessionSnapshot } from "../shared/protocol";
import { explainPermission } from "./permission-explainer";

interface InternalSession extends SessionSnapshot {
  stateSince: number;
  lastSequenceBySource: Map<string, number>;
}

interface SessionTombstone {
  stateSince: number;
  expiresAt: number;
  lastSequenceBySource: Map<string, number>;
}

const STATE_PRIORITY: Record<SessionSnapshot["state"], number> = {
  waiting: 6,
  error: 5,
  done: 4,
  working: 3,
  thinking: 2,
  idle: 1,
};

export class SessionStore {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly tombstones = new Map<string, SessionTombstone>();

  apply(event: AgentEvent): "accepted" | "stale" {
    const key = `${event.agent}:${event.sessionId}`;
    const existing = this.sessions.get(key);
    const tombstone = this.tombstones.get(key);
    const sequenceMap = existing?.lastSequenceBySource || tombstone?.lastSequenceBySource || new Map<string, number>();
    const lastSequence = sequenceMap.get(event.sourceInstance) ?? -1;
    if (event.sequence <= lastSequence) return "stale";
    if (!existing && tombstone && event.emittedAt <= tombstone.stateSince) return "stale";
    sequenceMap.set(event.sourceInstance, event.sequence);

    if (event.kind === "session.ended") {
      this.sessions.delete(key);
      this.tombstones.set(key, {
        stateSince: event.emittedAt,
        expiresAt: Date.now() + 30 * 60 * 1000,
        lastSequenceBySource: sequenceMap,
      });
      return "accepted";
    }

    const current = existing || createSession(event, key, sequenceMap);
    this.tombstones.delete(key);
    current.lastSeenAt = Math.max(current.lastSeenAt, event.emittedAt);

    if (event.kind === "heartbeat") {
      this.sessions.set(key, current);
      return "accepted";
    }

    const isContextOnly = event.kind === "context.updated" || event.kind === "session.started";
    if (!isContextOnly && event.emittedAt + 2_000 < current.stateSince) return "stale";

    current.agent = event.agent;
    current.project = event.project || current.project;
    current.title = event.title || current.title;
    current.summary = event.summary || current.summary;
    current.updatedAt = Math.max(current.updatedAt, event.emittedAt);

    if (event.kind === "context.updated" || event.kind === "session.started") {
      this.sessions.set(key, current);
      this.capSessions();
      return "accepted";
    }

    if (event.kind === "permission.resolved" || event.kind === "question.resolved") {
      if (!event.requestId || current.pendingPermission?.requestId === event.requestId) current.pendingPermission = undefined;
      current.state = "working";
      current.stateSince = event.emittedAt;
      this.sessions.set(key, current);
      return "accepted";
    }

    current.state = stateFor(event.kind);
    current.stateSince = event.emittedAt;
    if (event.kind === "permission.requested" || event.kind === "question.asked") {
      current.pendingPermission = {
        ...explainPermission(event),
        requestId: event.requestId,
        eventId: event.eventId,
      };
    } else if (["task.completed", "task.failed", "state.thinking", "state.working"].includes(event.kind)) {
      current.pendingPermission = undefined;
    }

    this.sessions.set(key, current);
    this.capSessions();
    return "accepted";
  }

  cleanup(now = Date.now()): void {
    for (const [key, tombstone] of this.tombstones) {
      if (now > tombstone.expiresAt) this.tombstones.delete(key);
    }
    for (const [key, session] of this.sessions) {
      const age = now - session.lastSeenAt;
      const ttl = session.state === "waiting"
        ? 2 * 60 * 60 * 1000
        : session.state === "working" || session.state === "thinking"
          ? 10 * 60 * 1000
          : session.state === "done" || session.state === "error"
            ? 30 * 60 * 1000
            : 15 * 60 * 1000;
      if (age > ttl) this.sessions.delete(key);
    }
  }

  snapshot(eventCount: number): HubSnapshot {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => {
        const priority = STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state];
        return priority || right.updatedAt - left.updatedAt || left.key.localeCompare(right.key);
      })
      .map(toPublicSession);
    return {
      generatedAt: Date.now(),
      sessions,
      activeCount: sessions.filter((session) => !["idle", "done"].includes(session.state)).length,
      topState: sessions[0]?.state || "idle",
      eventCount,
    };
  }

  private capSessions(): void {
    if (this.sessions.size <= 50) return;
    const oldest = [...this.sessions.values()].sort((left, right) => left.lastSeenAt - right.lastSeenAt)[0];
    if (oldest) this.sessions.delete(oldest.key);
  }
}

function createSession(event: AgentEvent, key: string, lastSequenceBySource = new Map<string, number>()): InternalSession {
  return {
    key,
    agent: event.agent,
    sessionId: event.sessionId,
    state: "idle",
    project: event.project || event.cwd || "未命名项目",
    title: event.title || "新会话",
    summary: event.summary || "等待 Agent 上报状态",
    updatedAt: event.emittedAt,
    lastSeenAt: event.emittedAt,
    stateSince: event.emittedAt,
    lastSequenceBySource,
  };
}

function stateFor(kind: AgentEvent["kind"]): SessionSnapshot["state"] {
  switch (kind) {
    case "state.thinking": return "thinking";
    case "state.working": return "working";
    case "permission.requested":
    case "question.asked": return "waiting";
    case "task.completed": return "done";
    case "task.failed": return "error";
    default: return "idle";
  }
}

function toPublicSession(session: InternalSession): SessionSnapshot {
  return {
    key: session.key,
    agent: session.agent,
    sessionId: session.sessionId,
    state: session.state,
    project: session.project,
    title: session.title,
    summary: session.summary,
    updatedAt: session.updatedAt,
    lastSeenAt: session.lastSeenAt,
    pendingPermission: session.pendingPermission,
  };
}
