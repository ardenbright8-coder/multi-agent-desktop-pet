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

test("agent roster defaults to the five groups and persists additions", () => {
  const { roster, path, root } = tempRoster();
  try {
    // 2026-09-24 加了 Antigravity，放在 Hermes 上面（用户：「多加一个 Agent 放到 Hermes 上面」）
    assert.deepEqual(AGENT_DEFAULTS, ["Claude", "ChatGPT", "Pi Agent", "Antigravity", "Hermes"]);
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
    assert.deepEqual(roster.list(), ["Hermes", "Claude", "ChatGPT", "Pi Agent", "Antigravity"]);
    roster.move("Pi Agent", "Claude", "below");
    assert.deepEqual(roster.list(), ["Hermes", "Claude", "Pi Agent", "ChatGPT", "Antigravity"]);
    assert.deepEqual(new AgentRoster(path).list(), ["Hermes", "Claude", "Pi Agent", "ChatGPT", "Antigravity"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("「更多 Agent」折叠区：第一次收 Claude 下面的、新加的自动收、拖到哪组旁边跟哪边、收拿都记住", () => {
  const { roster, path, root } = tempRoster();
  try {
    assert.deepEqual(roster.fold(), { members: ["ChatGPT", "Pi Agent", "Antigravity", "Hermes"], open: true });
    roster.add("Gemini");
    assert.deepEqual(roster.fold().members.at(-1), "Gemini");
    roster.move("Pi Agent", "Claude", "above"); // 拖到 Claude 旁边＝拿出来
    assert.deepEqual(roster.list(), ["Pi Agent", "Claude", "ChatGPT", "Antigravity", "Hermes", "Gemini"]);
    assert.equal(roster.fold().members.includes("Pi Agent"), false);
    roster.move("Claude", "Hermes", "below"); // 拖进折叠区那几组中间＝收进去，排在名单最后
    assert.deepEqual(roster.fold().members.includes("Claude"), true);
    assert.equal(roster.list()[0], "Pi Agent");
    roster.setFolded("Claude", false);
    roster.setFoldOpen(false);
    const reloaded = new AgentRoster(path);
    assert.deepEqual(reloaded.list(), ["Pi Agent", "Claude", "ChatGPT", "Antigravity", "Hermes", "Gemini"]);
    assert.deepEqual(reloaded.fold(), { members: ["ChatGPT", "Antigravity", "Hermes", "Gemini"], open: false });
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
    // 老名单没有 agents-seen.json：新默认组 Antigravity 补一次，名单里没有 Hermes 就放最后
    assert.deepEqual(roster.list(), ["Claude", "ChatGPT", "Pi Agent", "Antigravity"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 老名单（加 Antigravity 之前存的，没有 agents-seen.json）：Antigravity 补一次、放在 Hermes 上面；用户删过的老默认组不复活；
// 补过一次以后用户再删它，也不再回来。
test("老名单补上新默认组 Antigravity：放 Hermes 上面、只补一次、删过的老组不复活", () => {
  const { path, root } = tempRoster();
  try {
    writeFileSync(path, JSON.stringify(["Claude", "Pi Agent", "Hermes", "我的组"]));
    const roster = new AgentRoster(path);
    assert.deepEqual(roster.list(), ["Claude", "Pi Agent", "Antigravity", "Hermes", "我的组"], "ChatGPT 是用户自己删的，不补");
    assert.deepEqual(new AgentRoster(path).list(), ["Claude", "Pi Agent", "Antigravity", "Hermes", "我的组"], "补完存了盘");
    new AgentRoster(path).remove("Antigravity");
    assert.deepEqual(new AgentRoster(path).list(), ["Claude", "Pi Agent", "Hermes", "我的组"], "删了就不再回来");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("老名单里没有 Hermes：Antigravity 补在最后；已经自己加过（大小写不同）就不重复", () => {
  const { path, root } = tempRoster();
  try {
    writeFileSync(path, JSON.stringify(["Claude", "ChatGPT"]));
    assert.deepEqual(new AgentRoster(path).list(), ["Claude", "ChatGPT", "Antigravity"]);
    const other = tempRoster();
    try {
      writeFileSync(other.path, JSON.stringify(["antigravity", "Claude", "Hermes"]));
      assert.deepEqual(new AgentRoster(other.path).list(), ["antigravity", "Claude", "Hermes"]);
    } finally {
      rmSync(other.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

