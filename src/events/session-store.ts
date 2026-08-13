import type { AgentEvent, HubSnapshot, InteractionResponseInput, SessionSnapshot } from "../shared/protocol";
import { presentInteraction } from "../interaction/presenter";

interface InternalSession extends SessionSnapshot {
  stateSince: number;
  lastSequenceBySource: Map<string, number>;
  pendingSourceInstance?: string;
  originPid?: number;
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
    if (event.originPid && event.originPid > 0) current.originPid = event.originPid;

    if (event.kind === "context.updated" || event.kind === "session.started") {
      this.sessions.set(key, current);
      this.capSessions();
      return "accepted";
    }

    if (event.kind === "permission.resolved" || event.kind === "question.resolved") {
      const resolvesPending = !current.pendingInteraction
        || !event.requestId
        || current.pendingInteraction.providerRequestId === event.requestId;
      if (resolvesPending) {
        current.pendingInteraction = undefined;
        current.pendingSourceInstance = undefined;
        current.state = "working";
        current.stateSince = event.emittedAt;
      } else {
        current.state = "waiting";
      }
      this.sessions.set(key, current);
      return "accepted";
    }

    const isIncidentalState = event.kind === "state.thinking" || event.kind === "state.working";
    const isForeignTerminalState = (event.kind === "task.completed" || event.kind === "task.failed")
      && event.sourceInstance !== current.pendingSourceInstance;
    if (current.pendingInteraction && (isIncidentalState || isForeignTerminalState)) {
      current.state = "waiting";
      this.sessions.set(key, current);
      return "accepted";
    }

    current.state = stateFor(event.kind);
    current.stateSince = event.emittedAt;
    if (event.kind === "permission.requested" || event.kind === "question.asked") {
      current.pendingInteraction = presentInteraction(event);
      current.pendingSourceInstance = event.sourceInstance;
    } else if (["task.completed", "task.failed"].includes(event.kind)) {
      current.pendingInteraction = undefined;
      current.pendingSourceInstance = undefined;
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

  matchesInteraction(input: InteractionResponseInput): boolean {
    const session = this.sessions.get(`${input.agent}:${input.sessionId}`);
    const pending = session?.pendingInteraction;
    if (!pending || !pending.responseCapability || pending.eventId !== input.eventId) return false;
    if (pending.providerRequestId !== input.providerRequestId || input.answers.length !== pending.prompts.length) return false;
    const seen = new Set<string>();
    for (const answer of input.answers) {
      if (seen.has(answer.promptId)) return false;
      seen.add(answer.promptId);
      const prompt = pending.prompts.find((item) => item.id === answer.promptId);
      if (!prompt) return false;
      const optionIds = answer.optionIds || [];
      if (!prompt.multiple && optionIds.length > 1) return false;
      if (optionIds.some((id) => !prompt.options.some((option) => option.id === id))) return false;
      if (answer.customText && !prompt.allowCustomInput) return false;
      if (!optionIds.length && !answer.customText) return false;
    }
    return pending.prompts.every((prompt) => seen.has(prompt.id));
  }

  interactionSource(input: Pick<InteractionResponseInput, "agent" | "sessionId" | "eventId" | "providerRequestId">): string | undefined {
    const session = this.sessions.get(`${input.agent}:${input.sessionId}`);
    const pending = session?.pendingInteraction;
    if (!pending || pending.eventId !== input.eventId || pending.providerRequestId !== input.providerRequestId) return undefined;
    return session?.pendingSourceInstance;
  }

  updateInteractionStatus(input: InteractionResponseInput, status: "submitting" | "failed" | "submitted", error?: string): void {
    const session = this.sessions.get(`${input.agent}:${input.sessionId}`);
    const pending = session?.pendingInteraction;
    if (!session || !pending || pending.eventId !== input.eventId || pending.providerRequestId !== input.providerRequestId) return;
    if (status === "submitted") {
      session.pendingInteraction = undefined;
      session.pendingSourceInstance = undefined;
      session.state = "working";
      session.stateSince = Date.now();
      session.updatedAt = Date.now();
      return;
    }
    pending.responseStatus = status;
    pending.responseError = error;
  }

  /** 答案等了超时没人接（Agent 那头已经死了/断了）时，把这个待处理事项清掉，
   *  别留一个永远点不动的僵尸面板占着 waiting 状态（2026-08-12 实机踩到：
   *  19:46 的权限请求超时后 pending 没清，用户 20:43 再点旧面板，又等 20 秒又超时）。 */
  expireInteraction(input: Pick<InteractionResponseInput, "eventId" | "agent" | "sessionId" | "providerRequestId">): boolean {
    const session = this.sessions.get(`${input.agent}:${input.sessionId}`);
    const pending = session?.pendingInteraction;
    if (!session || !pending || pending.eventId !== input.eventId || pending.providerRequestId !== input.providerRequestId) return false;
    session.pendingInteraction = undefined;
    session.pendingSourceInstance = undefined;
    session.state = "idle";
    session.stateSince = Date.now();
    session.updatedAt = Date.now();
    return true;
  }

  /** 进程刚起来时，日记会把旧权限窗重放出来，但钩子已经不在等了。
   *  这种窗一点确认就卡在「正在交回」。启动时一律清掉。 */
  dropRestoredPending(): number {
    let dropped = 0;
    for (const session of this.sessions.values()) {
      if (!session.pendingInteraction) continue;
      session.pendingInteraction = undefined;
      session.pendingSourceInstance = undefined;
      if (session.state === "waiting") session.state = "idle";
      session.updatedAt = Date.now();
      dropped += 1;
    }
    return dropped;
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
    originPid: event.originPid,
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
    originPid: session.originPid,
    pendingInteraction: session.pendingInteraction,
  };
}
