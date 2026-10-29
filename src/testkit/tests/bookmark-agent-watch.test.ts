// 交活联动单测（2026-10-29 用户：拖、复制、六个点都一个逻辑；别加钩子，只靠看板程序盯 Claude、Pi、Antigravity 的会话记录）。
// 样例行照三家真记录的长相手写（2026-10-29 在本机看过）；期望答案都在这里手写。

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findHandoffs, parseSentLine, startAgentWatch, toNumber, windowNameFor, type SentMessage } from "../../bookmark/agent-watch";
import { BookmarkStore, HANDED_OUT } from "../../bookmark/store";

const PATH = "F:\\应用数据\\AgentPetHub\\bookmark\\条目（一条一份）\\mvs5ms8h-3d56bd3b.md";
const now = () => new Date().toISOString();

const claudeUser = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", isSidechain: false, sessionId: "64b7ed12-06e3-45fc-a88c-7bdbb84337a0", timestamp: now(), message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const piUser = (text: string) => JSON.stringify({ type: "message", id: "cebdc4e0", timestamp: now(), message: { role: "user", content: [{ type: "text", text }] } });
const agUser = (text: string) => JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: now(), content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });

test("parseSentLine：三家都只认他发的话；AI 回的、工具结果、系统附件不算", () => {
  const c = parseSentLine("Claude", "x\\64b7ed12.jsonl", claudeUser(`你干这个 ${PATH}`));
  assert.equal(c?.session, "64b7ed12-06e3-45fc-a88c-7bdbb84337a0");
  assert.match(c?.text ?? "", /mvs5ms8h/);
  assert.equal(parseSentLine("Claude", "x.jsonl", claudeUser("技能说明", { isMeta: true })), null, "系统附件");
  assert.equal(parseSentLine("Claude", "x.jsonl", JSON.stringify({ type: "user", sessionId: "s", timestamp: now(), message: { role: "user", content: [{ type: "tool_result", content: PATH }] } })), null, "工具结果");
  assert.equal(parseSentLine("Claude", "x.jsonl", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: PATH }] } })), null, "AI 回的");
  assert.equal(parseSentLine("Claude", "x.jsonl", claudeUser("帮小弟", { isSidechain: true })), null, "子助手");
  const p = parseSentLine("Pi", "C:\\h\\.pi\\agent\\sessions\\--C--\\2026-10-29T03-26-37-516Z_01a185b1-ffcb-7341-970d-cfa933209acf.jsonl", piUser("接第7条"));
  assert.equal(p?.session, "01a185b1-ffcb-7341-970d-cfa933209acf");
  assert.equal(parseSentLine("Pi", "a_b.jsonl", JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: PATH }] } })), null);
  const a = parseSentLine("Antigravity", "C:\\h\\.gemini\\antigravity\\brain\\378e5670-7626\\.system_generated\\logs\\transcript.jsonl", agUser("接捆2"));
  assert.equal(a?.session, "378e5670-7626");
  assert.equal(parseSentLine("Antigravity", "t.jsonl", JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: PATH })), null);
  assert.equal(parseSentLine("Claude", "x.jsonl", "{坏行"), null);
});

test("findHandoffs：路径、「接第 N 条」「接捆 N」都认；只看、问进度、没动词的不认", () => {
  assert.deepEqual(findHandoffs(`你干这个 ${PATH}`).ids, ["mvs5ms8h-3d56bd3b"]);
  assert.deepEqual(findHandoffs(`${PATH.replace(".md", "（原话）.md")}`).ids, ["mvs5ms8h-3d56bd3b"]);
  assert.deepEqual(findHandoffs(`只看看 ${PATH}`).ids, []);
  assert.deepEqual(findHandoffs("Claude 你接第 7 条").numbers, [7]);
  assert.deepEqual(findHandoffs("把第七条干了").numbers, [7]);
  assert.deepEqual(findHandoffs("接一下捆2").bundles, [2]);
  assert.deepEqual(findHandoffs("捆十二你来负责").bundles, [12]);
  assert.deepEqual(findHandoffs("第3条干完了吗").numbers, []);
  assert.deepEqual(findHandoffs("看一下第5条").numbers, []);
  assert.deepEqual(findHandoffs("第5条是什么意思").numbers, []);
  assert.deepEqual(findHandoffs("今天天气不错，第三天了").numbers, []);
  assert.equal(toNumber("二十一"), 21);
  assert.equal(windowNameFor("Pi", "01a185b1-ffcb-7341-970d-cfa933209acf"), "Pi-9acf", "Pi 会话号开头是时间，取末尾");
  assert.equal(windowNameFor("Claude", "64b7ed12-06e3-45fc-a88c-7bdbb84337a0"), "Claude-37a0");
});

test("startAgentWatch：在假用户夹里往三家记录追加一句，认得出；老话、AI 回话不认", async () => {
  const home = mkdtempSync(join(tmpdir(), "bm-watch-"));
  const claudeDir = join(home, ".claude", "projects", "C--Users");
  const piDir = join(home, ".pi", "agent", "sessions", "--C--");
  const agDir = join(home, ".gemini", "antigravity", "brain", "378e5670", ".system_generated", "logs");
  for (const d of [claudeDir, piDir, agDir]) mkdirSync(d, { recursive: true });
  const claudeFile = join(claudeDir, "s1.jsonl");
  writeFileSync(claudeFile, claudeUser("开窗以前说的 接第1条", { timestamp: "2026-01-01T00:00:00Z" }) + "\n", "utf8");
  const seen: SentMessage[] = [];
  const w = startAgentWatch(home, (m) => seen.push(m));
  try {
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(claudeFile, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: PATH }] } }) + "\n" + claudeUser(`你干这个 ${PATH}`) + "\n", "utf8");
    writeFileSync(join(piDir, "2026_01a185b1-aaaa.jsonl"), piUser("接第7条") + "\n", "utf8");
    writeFileSync(join(agDir, "transcript.jsonl"), agUser("接捆2") + "\n", "utf8");
    writeFileSync(join(agDir, "transcript_full.jsonl"), agUser("接捆9") + "\n", "utf8");
    const end = Date.now() + 5000;
    while (seen.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    const byAgent = Object.fromEntries(seen.map((m) => [m.agent, m.text]));
    assert.equal(seen.length, 3, JSON.stringify(seen.map((m) => [m.agent, m.text.slice(0, 20)])));
    assert.match(byAgent.Claude, /mvs5ms8h/, "Claude 只认这句，老话和 AI 回的不认");
    assert.equal(byAgent.Pi, "接第7条");
    assert.match(byAgent.Antigravity, /接捆2/, "只认 transcript.jsonl，transcript_full 不看");
  } finally {
    w.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("expireHandedOut：「已交出」过时间就放回去；没到时间、有窗口名在干的不动", () => {
  const root = mkdtempSync(join(tmpdir(), "bm-expire-"));
  try {
    const store = new BookmarkStore(join(root, "bookmarks.json"));
    const a = store.add({ text: "甲", assignee: "Claude" }).id;
    const b = store.add({ text: "乙", assignee: "Claude" }).id;
    store.handOut([a]);
    store.claimNext(b, "Claude-1");
    const t0 = Date.parse(store.list().find((r) => r.id === a)!.claimedAt!);
    assert.equal(store.expireHandedOut(180_000, t0 + 60_000), 0, "一分钟还没到");
    assert.equal(store.expireHandedOut(180_000, t0 + 181_000), 1);
    assert.equal(store.list().find((r) => r.id === a)?.claimedBy, null);
    assert.equal(store.list().find((r) => r.id === b)?.claimedBy, "Claude-1");
    assert.notEqual(HANDED_OUT, "Claude-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
