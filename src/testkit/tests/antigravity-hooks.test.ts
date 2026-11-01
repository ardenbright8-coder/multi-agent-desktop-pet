// Antigravity 钩子单测：路径不带引号、走门卫、桌宠钩子没了放行、没 Node.js 就摘掉。不碰真的 ~/.gemini。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAntigravityHooks } from "../../integrations/manager";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-antigravity-"));
  const hub = join(root, "hub");
  const config = join(root, "config");
  mkdirSync(join(hub, "integrations"), { recursive: true });
  mkdirSync(config, { recursive: true });
  const bridge = join(hub, "integrations", "agent-pet-hook.mjs");
  writeFileSync(bridge, 'process.stdout.write("REAL " + process.argv.slice(2).join(" ") + "\\n");\n', "utf8");
  const hooksFile = join(config, "hooks.json");
  writeFileSync(hooksFile, JSON.stringify({ other: { Stop: [] } }), "utf8");
  const before = process.env.AGENT_PET_HUB_HOME;
  process.env.AGENT_PET_HUB_HOME = hub;
  return {
    root, bridge, hooksFile, stub: join(config, "agent-pet-hook-stub.mjs"),
    done() {
      if (before === undefined) delete process.env.AGENT_PET_HUB_HOME;
      else process.env.AGENT_PET_HUB_HOME = before;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// 照 Antigravity 的跑法：按空格切开，不去引号
function runLikeAntigravity(command: string): string {
  const [, script, ...args] = command.split(" ");
  return execFileSync(process.execPath, [script, ...args], { encoding: "utf8", input: "{}" });
}

test("Antigravity 钩子指向门卫、命令不带引号，别人的命名钩子不动", () => {
  const t = setup();
  try {
    assert.equal(ensureAntigravityHooks(t.hooksFile, () => true), true);
    const config = JSON.parse(readFileSync(t.hooksFile, "utf8"));
    assert.deepEqual(config.other, { Stop: [] });
    const command: string = config["multi-agent-desktop-pet"].PreToolUse[0].hooks[0].command;
    assert.ok(!command.includes('"'), command);
    assert.ok(command.includes("agent-pet-hook-stub.mjs"), command);
    assert.ok(existsSync(t.stub));
    assert.equal(ensureAntigravityHooks(t.hooksFile, () => true), false, "第二次不重写");
  } finally {
    t.done();
  }
});

test("门卫：桌宠钩子在就转交，没了就放行、退出码 0", () => {
  const t = setup();
  try {
    ensureAntigravityHooks(t.hooksFile, () => true);
    const config = JSON.parse(readFileSync(t.hooksFile, "utf8"));
    const pre: string = config["multi-agent-desktop-pet"].PreToolUse[0].hooks[0].command;
    const stop: string = config["multi-agent-desktop-pet"].Stop[0].command;
    assert.equal(runLikeAntigravity(pre).trim(), "REAL antigravity PreToolUse");
    unlinkSync(t.bridge);
    assert.equal(runLikeAntigravity(pre).trim(), '{"decision":"allow"}');
    assert.equal(runLikeAntigravity(stop).trim(), "{}");
  } finally {
    t.done();
  }
});

test("门卫：桌宠钩子本身坏了（加载出错）也放行", () => {
  const t = setup();
  try {
    ensureAntigravityHooks(t.hooksFile, () => true);
    writeFileSync(t.bridge, "this is not javascript {{{", "utf8");
    const config = JSON.parse(readFileSync(t.hooksFile, "utf8"));
    assert.equal(runLikeAntigravity(config["multi-agent-desktop-pet"].PreToolUse[0].hooks[0].command).trim(), '{"decision":"allow"}');
  } finally {
    t.done();
  }
});

test("没装 Node.js：摘掉桌宠那块，别人的留着", () => {
  const t = setup();
  try {
    ensureAntigravityHooks(t.hooksFile, () => true);
    assert.equal(ensureAntigravityHooks(t.hooksFile, () => false), true);
    const config = JSON.parse(readFileSync(t.hooksFile, "utf8"));
    assert.equal(config["multi-agent-desktop-pet"], undefined);
    assert.deepEqual(config.other, { Stop: [] });
    assert.equal(ensureAntigravityHooks(t.hooksFile, () => false), false, "已经摘了不再写");
  } finally {
    t.done();
  }
});
