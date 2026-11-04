import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDataRoot, isIsolatedRun } from "../../shared/paths";
import { ensureAgentHookPaths, ensureClaudeHooks } from "../../integrations/manager";

// 2026-10-24：真机设了 AGENT_PET_HUB_HOME（两套共用数据）就被当成测试，六个点开不了 Agent。这里盯住判法。
test("isolated run is decided by the explicit marker or a temp/test-runs data folder, not by the data env var alone", () => {
  const saved = { home: process.env.AGENT_PET_HUB_HOME, flag: process.env.AGENT_PET_ISOLATED };
  try {
    delete process.env.AGENT_PET_ISOLATED;
    delete process.env.AGENT_PET_HUB_HOME;
    assert.equal(isIsolatedRun(), false);
    if (existsSync("F:\\应用数据\\AgentPetHub")) {
      assert.equal(appDataRoot(), "F:\\应用数据\\AgentPetHub", "没设环境变量但不是隔离测试时，按数据夹位置.json 找共用数据夹");
    }
    process.env.AGENT_PET_HUB_HOME = "F:\\应用数据\\AgentPetHub";
    assert.equal(isIsolatedRun(), false, "真用的共用数据夹不算测试");
    process.env.AGENT_PET_HUB_HOME = join(tmpdir(), "bm-carry-abc");
    assert.equal(isIsolatedRun(), true);
    process.env.AGENT_PET_HUB_HOME = "F:\\程序\\0016_多Agent桌面宠物\\.runtime\\test-runs\\unit-1";
    assert.equal(isIsolatedRun(), true);
    process.env.AGENT_PET_HUB_HOME = "F:\\应用数据\\AgentPetHub";
    process.env.AGENT_PET_ISOLATED = "1";
    assert.equal(isIsolatedRun(), true);
  } finally {
    if (saved.home === undefined) delete process.env.AGENT_PET_HUB_HOME; else process.env.AGENT_PET_HUB_HOME = saved.home;
    if (saved.flag === undefined) delete process.env.AGENT_PET_ISOLATED; else process.env.AGENT_PET_ISOLATED = saved.flag;
  }
});

test("ensureClaudeHooks：只有旧的 3 条钩子时，开机自检自动补齐 11 个事件且不动用户其它钩子", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-pet-claude-hooks-"));
  const savedHome = process.env.AGENT_PET_HUB_HOME;
  process.env.AGENT_PET_HUB_HOME = tempRoot;
  try {
    const bridgeDir = join(tempRoot, "integrations");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, "agent-pet-hook.mjs"), "// stub\n", "utf8");
    const settingsFile = join(tempRoot, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({
      env: { KEEP_ME: "1" },
      hooks: {
        PermissionRequest: [
          { matcher: "", hooks: [{ type: "command", command: "node \"C:/old/agent-pet-hook.mjs\" claude-code PermissionRequest", timeout: 30 }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: "node \"E:/my-own-hook.js\"", timeout: 5 }] },
        ],
      },
    }, null, 2), "utf8");

    assert.equal(ensureClaudeHooks(settingsFile), true);
    assert.equal(ensureClaudeHooks(settingsFile), false, "第二次再跑已齐，不重复写盘");
    const updated = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(updated.env.KEEP_ME, "1");
    assert.equal(Object.keys(updated.hooks).length, 11);
    assert.equal(updated.hooks.UserPromptSubmit.length, 2, "用户原有的 UserPromptSubmit 钩子保留，新增桌宠那条");
    assert.equal(updated.hooks.PermissionRequest[0].hooks[0].timeout, 180, "超时过短的自动拉回 180 秒");
    assert.ok(updated.hooks.PermissionRequest[0].hooks[0].command.includes(bridgeDir.replaceAll("\\", "/")));
  } finally {
    if (savedHome === undefined) delete process.env.AGENT_PET_HUB_HOME;
    else process.env.AGENT_PET_HUB_HOME = savedHome;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// 2026-11-04：看板验证脚本起的隔离实例把真 Claude／Antigravity／Grok 钩子改指到临时夹，临时夹一清钩子全断。
test("隔离实例（数据夹在临时夹）不碰各家真钩子配置", () => {
  const saved = { home: process.env.AGENT_PET_HUB_HOME, flag: process.env.AGENT_PET_ISOLATED };
  try {
    delete process.env.AGENT_PET_ISOLATED;
    process.env.AGENT_PET_HUB_HOME = join(tmpdir(), "bm-hold-guard");
    assert.deepEqual(ensureAgentHookPaths(), { changed: [], skipped: "isolated-run" });
    process.env.AGENT_PET_HUB_HOME = "F:\\应用数据\\AgentPetHub";
    process.env.AGENT_PET_ISOLATED = "1";
    assert.deepEqual(ensureAgentHookPaths(), { changed: [], skipped: "isolated-run" });
  } finally {
    if (saved.home === undefined) delete process.env.AGENT_PET_HUB_HOME; else process.env.AGENT_PET_HUB_HOME = saved.home;
    if (saved.flag === undefined) delete process.env.AGENT_PET_ISOLATED; else process.env.AGENT_PET_ISOLATED = saved.flag;
  }
});
