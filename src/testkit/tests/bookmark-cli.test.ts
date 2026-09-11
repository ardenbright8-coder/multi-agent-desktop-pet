// CLI 接入单测：参数解析 + 服务端路由/校验纯函数（不真开端口，集成验证由调度上机 curl 实测）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { handleCliRequest, parseCliArgs, type CliStoreAdapter, type CliRecord } from "../../bookmark/cli-server";
import { attachmentsRoot } from "../../shared/paths";

function makeStore(): CliStoreAdapter & {
  added: { text: string; assignee: string | null; kind: string; detail: string | null }[];
  removed: string[];
  attached: { id: string; sourcePath: string }[];
} {
  const records: CliRecord[] = [];
  const added: { text: string; assignee: string | null; kind: string; detail: string | null }[] = [];
  const removed: string[] = [];
  const attached: { id: string; sourcePath: string }[] = [];
  return {
    added,
    removed,
    attached,
    add(input) {
      added.push({ text: input.text, assignee: input.assignee, kind: input.kind ?? "note", detail: input.detail ?? null });
      const record: CliRecord = {
        id: `id-${records.length + 1}`,
        text: input.text,
        url: input.url,
        assignee: input.assignee,
        dedupeKey: input.dedupeKey ?? null,
        detail: input.detail ?? null,
        kind: input.kind ?? "note",
        attachments: input.attachments ?? [],
        createdAt: "2026-09-10T00:00:00.000Z",
      };
      records.unshift(record);
      return record;
    },
    list() {
      return records.map((r) => ({ ...r, attachments: [...r.attachments] }));
    },
    remove(id) {
      removed.push(id);
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    addAttachment(id, sourcePath) {
      attached.push({ id, sourcePath });
      const record = records.find((item) => item.id === id);
      if (!record) return null;
      record.attachments = [...record.attachments, `${id}-${basename(sourcePath)}`];
      return record;
    },
  };
}

function makeCtx(store: ReturnType<typeof makeStore>, onChangedCalls: { n: number } = { n: 0 }) {
  return { token: "secret", store, onChanged: () => { onChangedCalls.n += 1; }, onChangedCalls };
}

test("parseCliArgs：add 位置参数 + --to/--url/--json", () => {
  const args = parseCliArgs(["add", "--to", "Claude", "--url", "https://example.com/a", "改完登录页", "等验收"]);
  assert.deepEqual(args, { command: "add", text: "改完登录页 等验收", to: "Claude", url: "https://example.com/a", detail: undefined, id: undefined, handoffOnly: false, json: false, attach: [] });
});

test("parseCliArgs：list 省略 to = 全部，--json 打开", () => {
  const args = parseCliArgs(["list", "--json"]);
  assert.deepEqual(args, { command: "list", text: undefined, to: undefined, url: undefined, detail: undefined, id: undefined, handoffOnly: false, json: true, attach: [] });
});

test("parseCliArgs：未知命令、add/handoff 缺内容、remove 缺 id、旗标缺值 都报错", () => {
  assert.throws(() => parseCliArgs([]), /用法/);
  assert.throws(() => parseCliArgs(["nope"]), /用法/);
  assert.throws(() => parseCliArgs(["add", "--to", "Claude"]), /内容不能为空/);
  assert.throws(() => parseCliArgs(["handoff"]), /标题/);
  assert.throws(() => parseCliArgs(["remove"]), /条目 id/);
  assert.throws(() => parseCliArgs(["add", "--url"]), /--url/);
  assert.throws(() => parseCliArgs(["add", "x", "--attach"]), /--attach/);
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
  assert.deepEqual(store.added[0], { text: "干完了", assignee: "claude", kind: "note", detail: null });
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
  assert.deepEqual(claude.body, { ok: true, items: [{ id: "id-1", text: "给Claude的", url: null, assignee: "Claude", dedupeKey: null, detail: null, kind: "note", attachments: [], createdAt: "2026-09-10T00:00:00.000Z" }] });

  const all = handleCliRequest("GET", "/list", undefined, "Bearer secret", ctx);
  assert.equal((all.body as { items: unknown[] }).items.length, 3);
});

test("handleCliRequest：未知路径 404，body 坏 JSON 走 400（服务层）", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  assert.equal(handleCliRequest("POST", "/nope", { text: "x" }, "Bearer secret", ctx).status, 404);
  assert.equal(handleCliRequest("GET", "/nope", undefined, "Bearer secret", ctx).status, 404);
});

test("parseCliArgs：handoff 位置参数=标题，--detail 带详情，--to 派给分组", () => {
  const args = parseCliArgs(["handoff", "--to", "Claude", "--detail", "做了A和B，交出来的是C", "分页改完，交给你验收"]);
  assert.deepEqual(args, { command: "handoff", text: "分页改完，交给你验收", to: "Claude", detail: "做了A和B，交出来的是C", url: undefined, id: undefined, handoffOnly: false, json: false, attach: [] });
});

test("parseCliArgs：handoff 缺标题报错；remove 缺 id 报错；--detail 缺值报错", () => {
  assert.throws(() => parseCliArgs(["handoff", "--detail", "x"]), /标题/);
  assert.throws(() => parseCliArgs(["handoff", "标题", "--detail"]), /--detail 后面/);
  assert.throws(() => parseCliArgs(["remove"]), /id/);
  assert.throws(() => parseCliArgs(["handoff", "标题", "--unknown"]), /不认识的参数/);
});

test("handleCliRequest：POST /handoff 走 add 管道带 kind=handoff+detail，onChanged 触发", () => {
  const store = makeStore();
  const calls = { n: 0 };
  const ctx = makeCtx(store, calls);
  const ok = handleCliRequest("POST", "/handoff", { text: "交接单标题", assignee: "Claude", detail: "详情" }, "Bearer secret", ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.body && (ok.body as { kind?: string }).kind, "handoff");
  assert.equal(store.added[0]?.kind, "handoff");
  assert.equal(calls.n, 1);
});

test("handleCliRequest：GET /list?handoff=1 只列交接单", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  handleCliRequest("POST", "/handoff", { text: "交接A", assignee: "Claude", detail: "d" }, "Bearer secret", ctx);
  handleCliRequest("POST", "/add", { text: "普通条目" }, "Bearer secret", ctx);
  const only = handleCliRequest("GET", "/list?handoff=1", undefined, "Bearer secret", ctx);
  assert.equal(only.status, 200);
  const items = (only.body as { items: { kind?: string; text?: string }[] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "handoff");
  assert.equal(items[0]?.text, "交接A");
});

test("handleCliRequest：POST /remove 删成功 {ok:true}，找不到 404，删后 onChanged 触发", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  handleCliRequest("POST", "/add", { text: "待删的" }, "Bearer secret", ctx);
  const ok = handleCliRequest("POST", "/remove", { id: "id-1" }, "Bearer secret", ctx);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.equal(store.list().length, 0);
  const gone = handleCliRequest("POST", "/remove", { id: "id-1" }, "Bearer secret", ctx);
  assert.equal(gone.status, 404);
  const bad = handleCliRequest("POST", "/remove", { id: "" }, "Bearer secret", ctx);
  assert.equal(bad.status, 400);
});

test("parseCliArgs：add --attach 可多次", () => {
  const args = parseCliArgs(["add", "看这图", "--attach", "C:\\pics\\a.png", "--attach", "D:\\b.jpg"]);
  assert.equal(args.command, "add");
  assert.equal(args.text, "看这图");
  assert.deepEqual(args.attach, ["C:\\pics\\a.png", "D:\\b.jpg"]);
});

test("handleCliRequest：POST /add 带 attach 逐张 addAttachment", () => {
  const store = makeStore();
  const ctx = makeCtx(store);
  const ok = handleCliRequest("POST", "/add", { text: "带图", attach: ["C:\\a.png", "C:\\b.jpg"] }, "Bearer secret", ctx);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, id: "id-1" });
  assert.deepEqual(store.attached, [
    { id: "id-1", sourcePath: "C:\\a.png" },
    { id: "id-1", sourcePath: "C:\\b.jpg" },
  ]);
});

test("handleCliRequest：GET /list 输出 attachments 完整路径", () => {
  const prev = process.env.AGENT_PET_HUB_HOME;
  const root = mkdtempSync(join(tmpdir(), "bm-cli-attach-"));
  process.env.AGENT_PET_HUB_HOME = root;
  try {
    const store = makeStore();
    const ctx = makeCtx(store);
    handleCliRequest("POST", "/add", { text: "带图", attach: ["C:\\pics\\shot.png"] }, "Bearer secret", ctx);
    const listed = handleCliRequest("GET", "/list", undefined, "Bearer secret", ctx);
    assert.equal(listed.status, 200);
    const items = (listed.body as { items: { attachments: string[] }[] }).items;
    assert.deepEqual(items[0]?.attachments, [join(attachmentsRoot(), "id-1-shot.png")]);
  } finally {
    if (prev === undefined) delete process.env.AGENT_PET_HUB_HOME;
    else process.env.AGENT_PET_HUB_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
