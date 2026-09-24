// 启动 Agent 开窗单测（2026-09-24 用户拍板做法1：只开窗，用户自己 Ctrl+V 回车）：哪个组开桌面上哪个快捷方式。

import assert from "node:assert/strict";
import test from "node:test";
import { agentShortcutFor } from "../../bookmark/launch";

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
