import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const root = resolve(".runtime", "test-runs", `integration-${Date.now()}-${process.pid}`);
const bridgeDir = join(root, "integrations");
mkdirSync(bridgeDir, { recursive: true });
copyFileSync(resolve("integrations", "hooks", "agent-pet-hook.mjs"), join(bridgeDir, "agent-pet-hook.mjs"));
process.env.AGENT_PET_HUB_HOME = root;
process.env.AGENT_PET_SKIP_INTEGRATION_INSTALL = "1";

const { AgentHub } = require("../dist/events/hub.js");
const { LocalIpcServer } = require("../dist/channel/ipc-server.js");
const { LocalIpcClient } = require("../dist/channel/ipc-client.js");
const { discoveryPath } = require("../dist/shared/paths.js");
const journal = join(root, "data", "events.ndjson");
const hub = new AgentHub(journal, {
  running: false,
  endpoint: "",
  discoveryPath: discoveryPath(),
  ownerPid: process.pid,
  protocolVersion: 1,
});
const server = new LocalIpcServer(hub);

try {
  const discovery = await server.start();
  hub.updateServerInfo({ running: true, endpoint: discovery.endpoint });
  await runBridge("claude-code", "permission.requested", {
    session_id: "claude-isolated",
    cwd: process.cwd(),
    summary: "Claude Code 等待权限",
    request_id: "claude-permission",
    action: "只读测试",
    resources: ["package.json"],
    options: ["允许一次", "拒绝"],
  });
  await runBridge("pi", "state.working", { session_id: "pi-isolated", cwd: process.cwd(), tool_name: "read", summary: "Pi 正在读文件" });
  await runBridge("hermes", "state.working", { session_id: "hermes-isolated", cwd: process.cwd(), tool_name: "read", summary: "Hermes 正在读文件" });

  const pluginUrl = `${pathToFileURL(resolve("integrations", "opencode", "multi-agent-desktop-pet.mjs")).href}?test=${Date.now()}`;
  const { default: createOpenCodePlugin } = await import(pluginUrl);
  const opencode = await createOpenCodePlugin({ directory: process.cwd(), client: {} });
  await opencode.event({ event: { type: "session.created", properties: { sessionID: "opencode-isolated", info: { id: "opencode-isolated", title: "隔离接入测试", directory: process.cwd() } } } });
  await opencode["tool.execute.before"]({ sessionID: "opencode-isolated", tool: "read" }, { args: { filePath: "package.json" } });
  await waitFor(() => hub.snapshot().sessions.some((session) => session.agent === "opencode"));

  const client = new LocalIpcClient();
  const hello = await client.request("hello");
  assert.equal(hello.healthy, true);
  const agents = new Set(hub.snapshot().sessions.map((session) => session.agent));
  for (const agent of ["opencode", "claude-code", "pi", "hermes"]) assert.equal(agents.has(agent), true, `${agent} did not reach the hub`);
  const permission = hub.snapshot().sessions.find((session) => session.agent === "claude-code");
  assert.equal(permission?.state, "waiting");
  assert.equal(permission?.pendingInteraction?.providerRequestId, "claude-permission");
  const hits = await client.search({ text: "package.json", limit: 20 });
  assert.ok(hits.length >= 1);
  process.stdout.write(`INTEGRATION_SMOKE_OK agents=${[...agents].sort().join(",")} events=${hub.snapshot().eventCount} searchHits=${hits.length}\n`);
} finally {
  await server.close();
}

async function runBridge(agent, kind, payload) {
  const child = spawn(process.execPath, [resolve("integrations", "hooks", "agent-pet-hook.mjs"), agent, kind], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_PET_HUB_HOME: root },
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  assert.equal(code, 0, `${agent} bridge exited with ${code}`);
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for integration event");
}
