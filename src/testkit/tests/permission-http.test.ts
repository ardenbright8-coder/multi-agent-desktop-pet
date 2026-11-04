// Claude 权限直拨线（2026-11-04）：网址钩子登记得对、桌宠上的决定原样交回 Claude、Claude 挂断就收窗。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHub } from "../../events/hub";
import { startPermissionHttp, PERMISSION_HTTP_PATH } from "../../channel/permission-http";
import { ensureClaudeHooks } from "../../integrations/manager";
import type { AgentEvent } from "../../shared/protocol";

function withTempHome<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "agent-pet-permission-http-"));
  const saved = process.env.AGENT_PET_HUB_HOME;
  process.env.AGENT_PET_HUB_HOME = root;
  return Promise.resolve(fn(root)).finally(() => {
    if (saved === undefined) delete process.env.AGENT_PET_HUB_HOME; else process.env.AGENT_PET_HUB_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });
}

test("ensureClaudeHooks：给了直拨网址就把桌宠的 PermissionRequest 换成网址钩子，没给就换回命令钩子，别人的钩子不动", () => withTempHome((root) => {
  mkdirSync(join(root, "integrations"), { recursive: true });
  writeFileSync(join(root, "integrations", "agent-pet-hook.mjs"), "// stub\n", "utf8");
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({
    hooks: {
      PermissionRequest: [
        { matcher: "", hooks: [{ type: "command", command: "node \"C:/old/agent-pet-hook.mjs\" claude-code PermissionRequest", timeout: 30 }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "node \"E:/someone-else.js\"", timeout: 5 }] },
      ],
    },
  }), "utf8");
  const url = `http://127.0.0.1:23380${PERMISSION_HTTP_PATH}`;

  assert.equal(ensureClaudeHooks(settingsFile, { permissionUrl: url }), true);
  assert.equal(ensureClaudeHooks(settingsFile, { permissionUrl: url }), false, "已经对了就不重复写盘");
  let hooks = JSON.parse(readFileSync(settingsFile, "utf8")).hooks.PermissionRequest;
  const flat = () => hooks.flatMap((group: { hooks: unknown[] }) => group.hooks) as { type: string; url?: string; command?: string }[];
  assert.deepEqual(flat().filter((h) => h.type === "http"), [{ type: "http", url, timeout: 180 }]);
  assert.equal(flat().filter((h) => h.command?.includes("agent-pet-hook.mjs")).length, 0, "老的命令钩子摘掉，不留两条");
  assert.ok(flat().some((h) => h.command === "node \"E:/someone-else.js\""), "别人的钩子留着");

  // 端口换了：只改网址
  const moved = url.replace("23380", "23381");
  assert.equal(ensureClaudeHooks(settingsFile, { permissionUrl: moved }), true);
  hooks = JSON.parse(readFileSync(settingsFile, "utf8")).hooks.PermissionRequest;
  assert.equal(flat().filter((h) => h.type === "http").length, 1);
  assert.equal(flat().find((h) => h.type === "http")?.url, moved);

  // 直拨线没起来：换回命令钩子
  assert.equal(ensureClaudeHooks(settingsFile), true);
  hooks = JSON.parse(readFileSync(settingsFile, "utf8")).hooks.PermissionRequest;
  assert.equal(flat().filter((h) => h.type === "http").length, 0);
  assert.equal(flat().filter((h) => h.command?.includes("claude-code PermissionRequest")).length, 1);
}));

function post(port: number, body: string, abortAfterMs?: number): Promise<{ status: number; text: string } | "aborted"> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: PERMISSION_HTTP_PATH, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", (error) => (abortAfterMs ? resolve("aborted") : reject(error)));
    req.end(body);
    if (abortAfterMs) setTimeout(() => { req.destroy(); resolve("aborted"); }, abortAfterMs);
  });
}

test("直拨线：桌宠上的决定原样交回 Claude；Claude 挂断就发「已处理」收窗", () => withTempHome(async (root) => {
  const script = join(root, "fake-hook.mjs");
  // 假钩子：报出请求号；带 allow 就立刻回决定，否则一直等（模拟没人点）
  writeFileSync(script, [
    'let input = "";',
    'process.stdin.on("data", (c) => { input += c; });',
    'process.stdin.on("end", () => {',
    '  process.stderr.write("PET_REQUEST_ID=req-1\\n");',
    '  if (JSON.parse(input).tool_name === "Fast") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));',
    '  else setTimeout(() => {}, 60_000);',
    '});',
  ].join("\n"), "utf8");
  const hub = new AgentHub(join(root, "data", "events.ndjson"), { running: true, endpoint: "", discoveryPath: "", ownerPid: process.pid, protocolVersion: 1 });
  const events: AgentEvent[] = [];
  hub.on("event", (event: AgentEvent) => events.push(event));
  const server = await startPermissionHttp(hub, { hookScript: () => script, ports: [23390, 23391, 23392] });
  assert.ok(server, "端口要能占上");
  try {
    const answered = await post(server.port, JSON.stringify({ session_id: "s1", tool_name: "Fast" }));
    assert.notEqual(answered, "aborted");
    if (answered !== "aborted") {
      assert.equal(answered.status, 200);
      assert.equal(JSON.parse(answered.text).hookSpecificOutput.decision.behavior, "allow");
    }

    assert.equal(await post(server.port, JSON.stringify({ session_id: "s2", tool_name: "Slow" }), 600), "aborted");
    const deadline = Date.now() + 3_000;
    while (!events.some((e) => e.kind === "permission.resolved") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const resolved = events.find((e) => e.kind === "permission.resolved");
    assert.ok(resolved, "挂断后要发 permission.resolved");
    assert.equal(resolved?.requestId, "req-1");
    assert.equal(resolved?.sessionId, "s2");

    const wrongPath = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port: server.port, path: "/other", method: "POST" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end("{}");
    });
    assert.equal(wrongPath, 404, "别的地址一律不认");
  } finally {
    await server.close();
  }
}));
