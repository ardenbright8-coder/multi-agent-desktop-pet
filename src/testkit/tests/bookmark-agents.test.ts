import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_DEFAULTS, AgentRoster } from "../../bookmark/agents";

function tempRoster(): { roster: AgentRoster; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-bookmark-agents-"));
  const path = join(root, "agents.json");
  return { roster: new AgentRoster(path), path, root };
}

test("agent roster defaults to the four groups and persists additions", () => {
  const { roster, path, root } = tempRoster();
  try {
    assert.deepEqual(roster.list(), AGENT_DEFAULTS);
    const result = roster.add("Codex");
    assert.equal(result.existed, false);
    assert.deepEqual(result.list, [...AGENT_DEFAULTS, "Codex"]);
    const reloaded = new AgentRoster(path);
    assert.deepEqual(reloaded.list(), [...AGENT_DEFAULTS, "Codex"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent roster move reorders groups and persists", () => {
  const { roster, path, root } = tempRoster();
  try {
    roster.move("Hermes", "Claude", "above");
    assert.deepEqual(roster.list(), ["Hermes", "Claude", "ChatGPT", "Pi Agent"]);
    roster.move("Pi Agent", "Claude", "below");
    assert.deepEqual(roster.list(), ["Hermes", "Claude", "Pi Agent", "ChatGPT"]);
    assert.deepEqual(new AgentRoster(path).list(), ["Hermes", "Claude", "Pi Agent", "ChatGPT"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent roster dedupes case-insensitively and rejects empty or oversized names", () => {
  const { roster, root } = tempRoster();
  try {
    const again = roster.add("claude");
    assert.equal(again.existed, true);
    assert.equal(roster.list().length, AGENT_DEFAULTS.length);
    assert.throws(() => roster.add("   "), /名字不能为空/);
    assert.throws(() => roster.add("x".repeat(25)), /最长 24 个字/);
    roster.add("Codex");
    assert.equal(roster.has("codex"), true);
    assert.equal(roster.has("没人"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent roster removes a group (大小写不敏感) and reports misses", () => {
  const { roster, root } = tempRoster();
  try {
    assert.equal(roster.remove("pi agent"), true);
    assert.equal(roster.has("Pi Agent"), false);
    assert.equal(roster.remove("Pi Agent"), false);
    assert.equal(roster.remove(""), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent roster quarantines a corrupted file and falls back to defaults", () => {
  const { roster, path, root } = tempRoster();
  try {
    writeFileSync(path, "{oops 不是合法 JSON", "utf8");
    assert.deepEqual(roster.list(), AGENT_DEFAULTS);
    const quarantined = readdirSync(root).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
    // 坏档重来后照常增改。
    roster.add("Codex");
    assert.equal(new AgentRoster(path).list().includes("Codex"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent roster keeps valid entries when the file mixes junk rows", () => {
  const { path, root } = tempRoster();
  try {
    writeFileSync(path, `${JSON.stringify(["Claude", "ChatGPT", 42, null, "  ", "Pi Agent"])}\n`, "utf8");
    const roster = new AgentRoster(path);
    assert.deepEqual(roster.list(), ["Claude", "ChatGPT", "Pi Agent"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
