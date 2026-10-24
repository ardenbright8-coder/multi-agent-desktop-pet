import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIsolatedRun } from "../../shared/paths";

// 2026-10-24：真机设了 AGENT_PET_HUB_HOME（两套共用数据）就被当成测试，六个点开不了 Agent。这里盯住判法。
test("isolated run is decided by the explicit marker or a temp/test-runs data folder, not by the data env var alone", () => {
  const saved = { home: process.env.AGENT_PET_HUB_HOME, flag: process.env.AGENT_PET_ISOLATED };
  try {
    delete process.env.AGENT_PET_ISOLATED;
    delete process.env.AGENT_PET_HUB_HOME;
    assert.equal(isIsolatedRun(), false);
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
