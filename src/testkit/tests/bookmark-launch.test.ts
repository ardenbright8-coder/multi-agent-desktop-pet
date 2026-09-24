// 启动 Agent 开窗单测（2026-09-24 用户拍板做法2：开窗后替他按一次 Ctrl+V，回车他自己按）：
// 哪个组开桌面上哪个快捷方式；认新窗口、等它启动好、只往新窗口里贴。

import assert from "node:assert/strict";
import test from "node:test";
import { agentShortcutFor, pasteIntoAppWindow, pasteIntoNewWindow, type AppPasteDeps, type PasteDeps } from "../../bookmark/launch";

test("agentShortcutFor：四个默认组各对上桌面那个快捷方式，大小写和空格不管", () => {
  assert.deepEqual(agentShortcutFor("Claude"), { shortcut: "Claude Code 一.lnk", freshWindow: true });
  assert.deepEqual(agentShortcutFor("ChatGPT"), { shortcut: "Codex.lnk", freshWindow: false, app: "chatgpt.exe" });
  assert.deepEqual(agentShortcutFor("Pi Agent"), { shortcut: "Pi 编程智能体.lnk", freshWindow: true });
  assert.deepEqual(agentShortcutFor("Hermes"), { shortcut: "Hermes.lnk", freshWindow: false, app: "hermes.exe" });
  assert.deepEqual(agentShortcutFor(" claude "), { shortcut: "Claude Code 一.lnk", freshWindow: true });
  assert.deepEqual(agentShortcutFor("piagent"), { shortcut: "Pi 编程智能体.lnk", freshWindow: true });
  // 2026-09-24 加的第五家：开「Antigravity 反重力CLI」（命令窗口，跟 Pi 一样每点一次开一个新的）
  // 它开窗后要先登录好几秒，登录没完就贴会丢（2026-09-24 实测），所以多等：12 秒
  assert.deepEqual(agentShortcutFor("Antigravity"), { shortcut: "Antigravity 反重力CLI.lnk", freshWindow: true, settleMs: 12_000 });
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

// 桌面程序（Codex、Hermes）：已经开着的话点快捷方式只是把旧窗口切到前面，所以按「是哪个程序」认，不按新旧窗口认；
// 认到后等它启动好 → Ctrl+N 新开对话 → 还在它前面才 Ctrl+V（2026-09-24 用户：Hermes、Codex 拉出来了贴不进去）。
/** 假的 Windows：apps 是每次问「最前面是哪个程序」依次给的答案；按键按顺序记在 keys 里。 */
function fakeApps(apps: string[]): AppPasteDeps & { keys: string[]; slept: number } {
  let asked = 0;
  const fake = {
    keys: [] as string[],
    slept: 0,
    foreground: () => BigInt(asked + 1),
    processOf: () => apps[Math.min(asked++, apps.length - 1)],
    pressCtrlN: () => { fake.keys.push("Ctrl+N"); },
    pressCtrlV: () => { fake.keys.push("Ctrl+V"); },
    sleep: async (ms: number) => { fake.slept += ms; },
  };
  return fake;
}
const APP_TIMING = { pollMs: 200, appearTimeoutMs: 30_000, settleMs: 8_000, newChatMs: 1_500 };
const PANEL = String.raw`E:\app\electron.exe`;
const CODEX = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`;

test("pasteIntoAppWindow：Codex（程序叫 ChatGPT.exe）跑到最前面、启动好后还在 → 先 Ctrl+N 新开对话再 Ctrl+V，没有回车", async () => {
  const w = fakeApps([PANEL, PANEL, CODEX]);
  const r = await pasteIntoAppWindow("chatgpt.exe", w, APP_TIMING);
  assert.deepEqual(r, { ok: true, reason: null });
  assert.deepEqual(w.keys, ["Ctrl+N", "Ctrl+V"]);
});

test("pasteIntoAppWindow：程序名大小写不管、只看文件名不看路径", async () => {
  const w = fakeApps([String.raw`D:\hermes\win-unpacked\HERMES.EXE`]);
  const r = await pasteIntoAppWindow("hermes.exe", w, APP_TIMING);
  assert.equal(r.ok, true);
  const x = fakeApps([String.raw`D:\hermes-chatgpt.exe\other.exe`]);
  assert.equal((await pasteIntoAppWindow("chatgpt.exe", x, APP_TIMING)).ok, false);
});

test("pasteIntoAppWindow：一直是别的程序在最前面 → 等满再放弃，一个键都不按", async () => {
  const w = fakeApps([PANEL]);
  const r = await pasteIntoAppWindow("chatgpt.exe", w, APP_TIMING);
  assert.equal(r.ok, false);
  assert.deepEqual(w.keys, []);
  assert.ok(w.slept >= APP_TIMING.appearTimeoutMs);
});

test("pasteIntoAppWindow：等它启动时用户切走了、再没回来 → 等满放弃，不按 Ctrl+N 也不贴", async () => {
  const w = fakeApps([CODEX, PANEL]);
  const r = await pasteIntoAppWindow("chatgpt.exe", w, APP_TIMING);
  assert.deepEqual(r, { ok: false, reason: "等它启动时你点了别的窗口" });
  assert.deepEqual(w.keys, []);
});

test("pasteIntoAppWindow：启动时闪一下别的窗口又回来（启动画面、黑框一闪）→ 从回来那刻重新等满再贴", async () => {
  const w = fakeApps([CODEX, CODEX, PANEL, CODEX]);
  const r = await pasteIntoAppWindow("chatgpt.exe", w, APP_TIMING);
  assert.deepEqual(r, { ok: true, reason: null });
  assert.deepEqual(w.keys, ["Ctrl+N", "Ctrl+V"]);
  assert.ok(w.slept >= APP_TIMING.settleMs + 3 * APP_TIMING.pollMs, `闪走后要重新等满 ${APP_TIMING.settleMs}ms，实际共等 ${w.slept}`);
});

test("pasteIntoAppWindow：按了 Ctrl+N 之后用户切走了 → 不贴", async () => {
  // 连续在前面够久（等满 settleMs）才按 Ctrl+N，按完再问一次时已经是别的程序
  const w = fakeApps([...Array(APP_TIMING.settleMs / APP_TIMING.pollMs).fill(CODEX), PANEL]);
  const r = await pasteIntoAppWindow("chatgpt.exe", w, APP_TIMING);
  assert.equal(r.ok, false);
  assert.deepEqual(w.keys, ["Ctrl+N"]);
});

test("pasteIntoAppWindow：问不出是哪个程序（空字符串）不算", async () => {
  const w = fakeApps([""]);
  assert.equal((await pasteIntoAppWindow("chatgpt.exe", w, APP_TIMING)).ok, false);
  assert.deepEqual(w.keys, []);
});
