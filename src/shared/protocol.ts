export const PROTOCOL_VERSION = 1;
export const APP_ID = "multi-agent-desktop-pet";
export const MAX_FRAME_BYTES = 64 * 1024;

export type EventKind =
  | "session.started"
  | "context.updated"
  | "state.thinking"
  | "state.working"
  | "permission.requested"
  | "permission.resolved"
  | "question.asked"
  | "question.resolved"
  | "task.completed"
  | "task.failed"
  | "session.ended"
  | "heartbeat";

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface AgentEvent {
  version: 1;
  eventId: string;
  sourceInstance: string;
  sequence: number;
  emittedAt: number;
  agent: string;
  sessionId: string;
  kind: EventKind;
  project?: string;
  cwd?: string;
  title?: string;
  summary?: string;
  reason?: string;
  tool?: string;
  target?: string;
  paths?: string[];
  risk?: RiskLevel;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionExplanation {
  heading: string;
  doing: string;
  request: string;
  reason: string;
  impact: string;
  risk: RiskLevel;
  irreversible: boolean;
}

export interface SessionSnapshot {
  key: string;
  agent: string;
  sessionId: string;
  state: "idle" | "thinking" | "working" | "waiting" | "done" | "error";
  project: string;
  title: string;
  summary: string;
  updatedAt: number;
  lastSeenAt: number;
  pendingPermission?: PermissionExplanation & { requestId?: string; eventId: string };
}

export interface HubSnapshot {
  generatedAt: number;
  sessions: SessionSnapshot[];
  activeCount: number;
  topState: SessionSnapshot["state"];
  eventCount: number;
}

export interface SearchQuery {
  text?: string;
  agent?: string;
  project?: string;
  sessionId?: string;
  kind?: EventKind;
  limit?: number;
}

export interface SearchHit {
  event: AgentEvent;
  score: number;
  terms: string[];
}

export interface DiagnosticsSnapshot {
  server: {
    running: boolean;
    endpoint: string;
    discoveryPath: string;
    ownerPid: number;
    protocolVersion: number;
  };
  events: {
    accepted: number;
    duplicate: number;
    stale: number;
    invalid: number;
    lastAcceptedAt: number | null;
    lastAgent: string | null;
  };
  journal: {
    path: string;
    count: number;
  };
  integrations: Array<{
    id: string;
    label: string;
    status: "connected" | "seen" | "not-seen" | "planned";
    lastSeenAt: number | null;
  }>;
}

export interface RpcRequest {
  id: string;
  version: number;
  token: string;
  method: "hello" | "event.publish" | "snapshot.get" | "search.query" | "diagnostics.get";
  params?: unknown;
}

export interface RpcResponse {
  id: string;
  version: number;
  app: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const EVENT_KINDS = new Set<EventKind>([
  "session.started",
  "context.updated",
  "state.thinking",
  "state.working",
  "permission.requested",
  "permission.resolved",
  "question.asked",
  "question.resolved",
  "task.completed",
  "task.failed",
  "session.ended",
  "heartbeat",
]);

function limitedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = redactSensitiveText(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}

export function redactSensitiveText(value: string): string {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'`,;]+/gi, "$1[已遮盖]")
    .replace(/\b(sk-[a-z0-9_-]{12,})\b/gi, "[已遮盖]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`,;]+/gi, "$1[已遮盖]");
}

export function normalizeAgentEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind as EventKind;
  const eventId = limitedString(raw.eventId, 160);
  const sourceInstance = limitedString(raw.sourceInstance, 160);
  const agent = limitedString(raw.agent, 80);
  const sessionId = limitedString(raw.sessionId, 200);
  if (
    raw.version !== PROTOCOL_VERSION ||
    !eventId ||
    !sourceInstance ||
    !agent ||
    !sessionId ||
    !EVENT_KINDS.has(kind) ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 0 ||
    typeof raw.emittedAt !== "number" ||
    !Number.isFinite(raw.emittedAt)
  ) {
    return null;
  }

  const paths = Array.isArray(raw.paths)
    ? raw.paths.map((item) => limitedString(item, 1000)).filter((item): item is string => Boolean(item)).slice(0, 20)
    : undefined;
  const risk = ["low", "medium", "high", "unknown"].includes(String(raw.risk))
    ? (raw.risk as RiskLevel)
    : undefined;
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? sanitizeMetadata(raw.metadata as Record<string, unknown>)
    : undefined;

  return {
    version: 1,
    eventId,
    sourceInstance,
    sequence: raw.sequence as number,
    emittedAt: raw.emittedAt,
    agent,
    sessionId,
    kind,
    project: limitedString(raw.project, 300),
    cwd: limitedString(raw.cwd, 1000),
    title: limitedString(raw.title, 500),
    summary: limitedString(raw.summary, 2000),
    reason: limitedString(raw.reason, 2000),
    tool: limitedString(raw.tool, 120),
    target: limitedString(raw.target, 2000),
    paths,
    risk,
    requestId: limitedString(raw.requestId, 200),
    metadata,
  };
}

function sanitizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    if (/token|secret|password|cookie|api.?key|authorization/i.test(key)) {
      output[key] = "[已遮盖]";
    } else if (typeof value === "string") {
      output[key] = redactSensitiveText(value).slice(0, 2000);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value.slice(0, 20).map((item) => typeof item === "string" ? item.slice(0, 500) : String(item).slice(0, 500));
    }
  }
  return output;
}
