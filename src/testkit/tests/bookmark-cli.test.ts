// CLI 接入单测：参数解析 + 服务端路由/校验纯函数（不真开端口，集成验证由调度上机 curl 实测）。

import assert from "node:assert/strict";
import test from "node:test";
import { handleCliRequest, parseCliArgs, type CliStoreAdapter, type CliRecord } from "../../bookmark/cli-server";

function makeStore(): CliStoreAdapter & { added: { text: string; assignee: string | null }[] } {
  const records: CliRecord[] = [];
  const added: { text: string; assignee: string | null }[] = [];
  return {
    added,
    add(input) {
      added.push({ text: input.text, assignee: input.assignee });
      const record: CliRecord = {
        id: `id-${records.length + 1}`,
        text: input.text,
        url: input.url,
        assignee: input.assignee,
        dedupeKey: input.dedupeKey ?? null,
        createdAt: "2026-09-10T00:00:00.000Z",
      };
      records.unshift(record);
      return record;
    },
    list() {
      return records.map((r) => ({ ...r }));
    },
  };
}

function makeCtx(store: ReturnType<typeof makeStore>, onChangedCalls: { n: number } = { n: 0 }) {
  return { token: "secret", store, onChanged: () => { onChangedCalls.n += 1; } };
}

test("parseCliArgs：add 位置参数 + --to/--url/--json", () => {
  const args = parseCliArgs(["add", "--to", "Claude", "--url", "https://example.com/a", "改完登录页", "等验收"]);
  assert.deepEqual(args, { command: "add", text: "改完登录页 等验收", to: "Claude", url: "https://example.com/a", json: false });
});

test("parseCliArgs：list 省略 to = 全部，--json 打开", () => {
  const args = parseCliArgs(["list", "--json"]);
  assert.deepEqual(args, { command: "list", text: undefined, to: undefined, url: undefined, json: true });
});

test("parseCliArgs：未知命令、add 缺内容、旗标缺值 都报错", () => {
  assert.throws(() => parseCliArgs([]), /用法/);
  assert.throws(() => parseCliArgs(["remove", "x"]), /用法/);
  assert.throws(() => parseCliArgs(["add", "--to", "Claude"]), /内容不能为空/);
  assert.throws(() => parseCliArgs(["add", "--url"]), /--url/);
});

test("handleCliRequest：token 不对一律 403，不带 Authorization 也 403", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  assert.equal(handleCliRequest("POST", "/add", { text: "x" }, undefined, ctx).status, 403);
  assert.equal(handleCliRequest("POST", "/add", { text: "x" }, "Bearer wrong", ctx).status, 403);
  assert.equal(store.added.length, 0);
});

test("handleCliRequest：POST /add 入库+回调刷新，缺内容 400", () => {
  const store = makeStore();
  const changed = { n: 0 };
  const ctx = makeCtx(store, changed);
  const ok = handleCliRequest("POST", "/add", { text: "  干完了  ", url: "https://e.com", assignee: "claude" }, "Bearer secret", ctx);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, id: "id-1" });
  assert.deepEqual(store.added[0], { text: "干完了", assignee: "claude" });
  assert.equal(changed.n, 1);
  const bad = handleCliRequest("POST", "/add", { text: "   " }, "Bearer secret", ctx);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { ok: false, error: "内容不能为空" });
});

test("handleCliRequest：GET /list 过滤 assignee 大小写不敏感，无 to 给全部", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  handleCliRequest("POST", "/add", { text: "给Claude的", assignee: "Claude" }, "Bearer secret", ctx);
  handleCliRequest("POST", "/add", { text: "给pi的", assignee: "Pi Agent" }, "Bearer secret", ctx);
  handleCliRequest("POST", "/add", { text: "待定的" }, "Bearer secret", ctx);

  const claude = handleCliRequest("GET", "/list?to=claude", undefined, "Bearer secret", ctx);
  assert.equal(claude.status, 200);
  assert.deepEqual(claude.body, { ok: true, items: [{ id: "id-1", text: "给Claude的", url: null, assignee: "Claude", dedupeKey: null, createdAt: "2026-09-10T00:00:00.000Z" }] });

  const all = handleCliRequest("GET", "/list", undefined, "Bearer secret", ctx);
  assert.equal((all.body as { items: unknown[] }).items.length, 3);
});

test("handleCliRequest：未知路径 404，body 坏 JSON 走 400（服务层）", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  assert.equal(handleCliRequest("POST", "/nope", { text: "x" }, "Bearer secret", ctx).status, 404);
  assert.equal(handleCliRequest("GET", "/nope", undefined, "Bearer secret", ctx).status, 404);
});
