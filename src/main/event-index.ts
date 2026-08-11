import MiniSearch from "minisearch";
import type { AgentEvent, SearchHit, SearchQuery } from "../shared/protocol";

interface SearchDocument {
  id: string;
  event: AgentEvent;
  agent: string;
  project: string;
  sessionId: string;
  kind: string;
  title: string;
  summary: string;
  reason: string;
  tool: string;
  target: string;
  paths: string;
  interaction: string;
  all: string;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function multilingualTokenize(input: string): string[] {
  const normalized = String(input || "").normalize("NFKC").toLowerCase();
  const segments = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_./\\:@-]+/gu) || [];
  const output = new Set<string>();

  for (const segment of segments) {
    if (CJK.test(segment)) {
      const chars = Array.from(segment);
      for (const char of chars) output.add(char);
      for (let index = 0; index < chars.length - 1; index += 1) {
        output.add(chars[index] + chars[index + 1]);
      }
    } else {
      const parts = segment.split(/[./\\:@_-]+/).filter(Boolean);
      if (parts.length === 1) output.add(segment);
      for (const part of parts) output.add(part);
    }
  }
  return [...output];
}

export class EventIndex {
  private readonly documents = new Map<string, SearchDocument>();
  private readonly index = new MiniSearch<SearchDocument>({
    fields: ["title", "summary", "reason", "tool", "target", "paths", "interaction", "agent", "project", "sessionId", "kind", "all"],
    storeFields: ["event", "agent", "project", "sessionId", "kind"],
    tokenize: multilingualTokenize,
    processTerm: (term) => term,
    searchOptions: {
      prefix: true,
      fuzzy: 0.15,
      combineWith: "AND",
      boost: { title: 4, summary: 3, interaction: 2.8, tool: 2.5, target: 2.5, paths: 2.5, project: 2, reason: 1.5 },
    },
  });

  add(event: AgentEvent): void {
    if (this.documents.has(event.eventId)) return;
    const document = toDocument(event);
    this.documents.set(event.eventId, document);
    this.index.add(document);
  }

  addAll(events: AgentEvent[]): void {
    for (const event of events) this.add(event);
  }

  remove(eventId: string): void {
    if (!this.documents.has(eventId)) return;
    this.documents.delete(eventId);
    this.index.discard(eventId);
  }

  search(query: SearchQuery): SearchHit[] {
    const limit = Math.max(1, Math.min(query.limit || 30, 60));
    const matchesFilter = (event: AgentEvent): boolean =>
      (!query.agent || event.agent === query.agent) &&
      (!query.project || event.project === query.project) &&
      (!query.sessionId || event.sessionId === query.sessionId) &&
      (!query.kind || event.kind === query.kind);

    if (!query.text?.trim()) {
      return [...this.documents.values()]
        .map((document) => document.event)
        .filter(matchesFilter)
        .sort((left, right) => right.emittedAt - left.emittedAt)
        .slice(0, limit)
        .map((event) => ({ event, score: 0, terms: [] }));
    }

    const text = query.text.trim();
    let results = this.index.search(text);
    if (!results.length && CJK.test(text)) {
      const requiredTerms = new Set(multilingualTokenize(text)).size;
      results = this.index.search(text, { combineWith: "OR", prefix: false, fuzzy: false })
        .filter((result) => new Set(result.terms || []).size / Math.max(requiredTerms, 1) >= 0.55);
    }
    return results
      .map((result) => ({
        event: result.event as AgentEvent,
        score: result.score,
        terms: result.terms || [],
      }))
      .filter((hit) => matchesFilter(hit.event))
      .slice(0, limit);
  }

  get size(): number {
    return this.documents.size;
  }
}

function toDocument(event: AgentEvent): SearchDocument {
  const interaction = event.interaction ? [
    event.interaction.title,
    event.interaction.recommendation,
    event.interaction.action,
    event.interaction.resources?.join(" "),
    ...event.interaction.prompts.flatMap((prompt) => [prompt.question, ...prompt.options.flatMap((option) => [option.label, option.description])]),
  ].filter(Boolean).join(" ") : "";
  const fields = [
    event.title,
    event.summary,
    event.reason,
    event.tool,
    event.target,
    event.paths?.join(" "),
    interaction,
    event.agent,
    event.project,
    event.sessionId,
    event.kind,
  ].filter(Boolean).join(" ");
  return {
    id: event.eventId,
    event,
    agent: event.agent,
    project: event.project || "",
    sessionId: event.sessionId,
    kind: event.kind,
    title: event.title || "",
    summary: event.summary || "",
    reason: event.reason || "",
    tool: event.tool || "",
    target: event.target || "",
    paths: event.paths?.join(" ") || "",
    interaction,
    all: fields,
  };
}
