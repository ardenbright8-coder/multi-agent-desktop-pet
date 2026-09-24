// 启动 Agent 开窗单测（2026-09-24 用户拍板做法2：开窗后替他按一次 Ctrl+V，回车他自己按）：
// 哪个组开桌面上哪个快捷方式；认新窗口、等它启动好、只往新窗口里贴。

import assert from "node:assert/strict";
import test from "node:test";
import { agentShortcutFor, pasteIntoNewWindow, type PasteDeps } from "../../bookmark/launch";

test("agentShortcutFor：四个默认组各对上桌面那个快捷方式，大小写和空格不管", () => {
  assert.deepEqual(agentShortcutFor("Claude"), { shortcut: "Claude Code 一.lnk", freshWindow: true });
  assert.deepEqual(agentShortcutFor("ChatGPT"), { shortcut: "Codex.lnk", freshWindow: false });
  assert.deepEqual(agentShortcutFor("Pi Agent"), { shortcut: "Pi 编程智能体.lnk", freshWindow: true });
  assert.deepEqual(agentShortcutFor("Hermes"), { shortcut: "Hermes.lnk", freshWindow: false });
  assert.deepEqual(agentShortcutFor(" claude "), { shortcut: "Claude Code 一.lnk", freshWindow: true });
  assert.deepEqual(agentShortcutFor("piagent"), { shortcut: "Pi 编程智能体.lnk", freshWindow: true });
});

test("agentShortcutFor：用户自己加的组认不出是谁，返回 null（只复制不开窗）", () => {
  assert.equal(agentShortcutFor("我的组"), null);
  assert.equal(agentShortcutFor(""), null);
  assert.equal(agentShortcutFor("Claude 二号"), null);
});

/** 假的 Windows：foregrounds 是每次问「最前面是谁」依次给的答案（问完了就一直给最后一个），时间只在 sleep 里走。 */
function fakeWindows(foregrounds: bigint[]): PasteDeps & { presses: number; slept: number } {
  let asked = 0;
  const fake = {
    presses: 0,
    slept: 0,
    foreground: () => foregrounds[Math.min(asked++, foregrounds.length - 1)],
    pressCtrlV: () => {
      fake.presses += 1;
    },
    sleep: async (ms: number) => {
      fake.slept += ms;
    },
  };
  return fake;
}

const OLD = new Set([1n, 2n, 3n]); // 开窗前就有的窗口（1n 是看板自己）
const TIMING = { pollMs: 200, appearTimeoutMs: 15_000, settleMs: 4_000 };

test("pasteIntoNewWindow：新窗口出来到最前面、启动好后还在最前面 → 按一次 Ctrl+V", async () => {
  const w = fakeWindows([1n, 1n, 99n, 99n]);
  const r = await pasteIntoNewWindow(OLD, w, TIMING);
  assert.deepEqual(r, { ok: true, reason: null });
  assert.equal(w.presses, 1);
});

test("pasteIntoNewWindow：最前面换成开窗前就有的旧窗口（用户点了别处）→ 不算，接着等；等不到就不贴", async () => {
  const w = fakeWindows([1n, 2n, 3n]);
  const r = await pasteIntoNewWindow(OLD, w, TIMING);
  assert.equal(r.ok, false);
  assert.equal(w.presses, 0);
  assert.ok(w.slept >= TIMING.appearTimeoutMs, `至少等满 ${TIMING.appearTimeoutMs}ms，实际 ${w.slept}`);
});

test("pasteIntoNewWindow：新窗口出来了，等它启动时用户切走了 → 不贴", async () => {
  const w = fakeWindows([1n, 99n, 2n]);
  const r = await pasteIntoNewWindow(OLD, w, TIMING);
  assert.equal(r.ok, false);
  assert.equal(w.presses, 0);
});

test("pasteIntoNewWindow：最前面是 0（没有窗口在前面）不算新窗口", async () => {
  const w = fakeWindows([0n]);
  const r = await pasteIntoNewWindow(OLD, w, TIMING);
  assert.equal(r.ok, false);
  assert.equal(w.presses, 0);
});
