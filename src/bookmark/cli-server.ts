// CLI 接入服务（2026-09-10 用户拍板）：让 AI agent 用命令行读写 Agent 看板——省 token、稳定。
// 「零常驻」指的是 CLI 本身：scripts/bookmark-cli.mjs 每次调用一个短进程，用完即退；
// 这边的 HTTP 小服务随主进程活（只听 127.0.0.1），主进程退出端口自然消失，没有「服务挂了」一说。
//
// 🚨 数据只许走 panel-window 注入的 store 适配器（与 IPC add 同一条 normalizeInput 管道），
//    CLI 绝不直写 bookmarks.json——主进程内存全量落盘会把直写冲掉。
// 🚨 隔离铁律：这里出任何幺蛾子（端口被占、请求炸）只记日志，不许连坐桌宠本体。

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";
import { createLogger } from "../shared/log";
import { attachmentsRoot, bookmarkCliPortPath } from "../shared/paths";
import { composeForAgent } from "./templates";

const log = createLogger("bookmark");

export interface CliRecord {
  id: string;
  text: string;
  url: string | null;
  assignee: string | null;
  dedupeKey: string | null;
  detail: string | null;
  kind: "note" | "handoff";
  /** list 出口会把文件名展开成 attachmentsRoot 下的完整路径。 */
  attachments: string[];
  createdAt: string;
  /** 捆号 / 谁领走了（设定15）；老适配器可以不给。 */
  bundleId?: string | null;
  claimedBy?: string | null;
}

/** 领活结果（store.claimNext 同形）：record 为 null = 没活可领，busy 是正在干的窗口名。 */
export interface CliClaim {
  record: CliRecord | null;
  position: number;
  total: number;
  remaining: number;
  busy: string[];
}

export interface CliStoreAdapter {
  add(input: { text: string; url: string | null; assignee: string | null; dedupeKey: string | null; detail?: string | null; kind?: "note" | "handoff"; attachments?: string[] }): CliRecord;
  list(): CliRecord[];
  /** 删除一条（交接完自删用）；没找到返回 false。 */
  remove(id: string): boolean;
  /** 拷源图进 attachments\ 并追到该条；没这条返 null。接线在 panel-window 适配器。 */
  addAttachment?(id: string, sourcePath: string): CliRecord | null;
  /** 领活三件套（设定15）：领下一条 / 用户说可以才删 / 放回去。 */
  claimNext?(target: string, by: string): CliClaim;
  done?(id: string, by: string, userOk: string): CliRecord;
  release?(id: string): CliRecord | null;
  /** 要求模板原文：coding = 「带编程」那份；没有返回 null。 */
  template?(name: "coding"): string | null;
}

export interface BookmarkCliDeps {
  store: CliStoreAdapter;
  /** 有新条目入库后回调（面板重拉列表）。回调抛错由调用处吞。 */
  onChanged?: () => void;
}

export interface BookmarkCliServerHandle {
  stop: () => void;
}

// ── CLI 参数解析（纯函数，scripts/bookmark-cli.mjs 经 dist 调用；node:test 直接测） ──

export interface CliArgs {
  command: "add" | "list" | "handoff" | "remove" | "next" | "done" | "release";
  /** next/done/release 的对象：捆号或条目 id。 */
  target?: string;
  /** 看板开窗时起的窗口名（如 Claude-3）。 */
  by?: string;
  /** done 时用户说「可以」的原话。 */
  ok?: string;
  /** next 带不带「带编程」那份要求。 */
  coding?: boolean;
  text?: string;
  to?: string;
  url?: string;
  detail?: string;
  id?: string;
  handoffOnly?: boolean;
  json: boolean;
  /** add --attach 的源图片路径（可多次）。 */
  attach: string[];
}

const CLI_USAGE =
  '用法：bookmark-cli add "内容" [--to Agent名] [--url 网址] [--attach 图片路径] [--json] | list [--to Agent名] [--handoff] [--json] | '
  + 'handoff "标题" [--to Agent名] [--detail 详情] | remove <条目id> | '
  + 'next <捆号或条目id> --by 窗口名 [--coding] | done <条目id> --by 窗口名 --ok "用户原话" | release <条目id> --by 窗口名';

/** 解析命令行参数。add/handoff 的位置参数拼接为内容；--to 省略 = 进待定区。参数不对抛错（消息是给 agent 看的用法）。 */
export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0];
  if (command === "next" || command === "done" || command === "release") return parseClaimArgs(command, argv);
  if (command !== "add" && command !== "list" && command !== "handoff" && command !== "remove") {
    throw new Error(CLI_USAGE);
  }
  const args: CliArgs = {
    command, text: undefined, to: undefined, url: undefined,
    detail: undefined, id: undefined, handoffOnly: false, json: false, attach: [],
  };
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      args.json = true;
    } else if (flag === "--to") {
      const value = argv[++i];
      if (value == null) throw new Error("--to 后面要跟 agent 名（大小写不敏感，对齐看板分组）");
      args.to = value;
    } else if (flag === "--url") {
      const value = argv[++i];
      if (value == null) throw new Error("--url 后面要跟网址");
      args.url = value;
    } else if (flag === "--detail") {
      const value = argv[++i];
      if (value == null) throw new Error("--detail 后面要跟详情内容（可长可短，不写就只有标题）");
      args.detail = value;
    } else if (flag === "--attach") {
      const value = argv[++i];
      if (value == null) throw new Error("--attach 后面要跟图片路径（可写多次各贴一张）");
      args.attach.push(value);
    } else if (flag === "--handoff") {
      args.handoffOnly = true;
    } else if (flag.startsWith("--")) {
      throw new Error(`不认识的参数 ${flag}。${CLI_USAGE}`);
    } else if (command === "remove" && args.id == null) {
      args.id = flag; // remove 的位置参数是条目 id
    } else {
      positional.push(flag);
    }
  }
  if (command === "add" || command === "handoff") {
    args.text = positional.join(" ").trim();
    if (!args.text) {
      throw new Error(command === "handoff"
        ? 'handoff 缺标题不能为空（写法：handoff "标题两行内说清交了啥" [--detail 详情] [--to Agent名]）'
        : 'add 缺内容不能为空（要记的话写一条：add "内容"）');
    }
  }
  if (command === "remove" && !args.id) {
    throw new Error('remove 缺条目 id（先 list 拿 id：remove <条目id>）');
  }
  return args;
}

/** 领活三件套的参数：一个位置参数（捆号或条目 id）+ --by（必填）+ done 的 --ok（必填，用户原话）+ next 的 --coding。 */
function parseClaimArgs(command: "next" | "done" | "release", argv: string[]): CliArgs {
  let target: string | undefined;
  let by: string | undefined;
  let coding = false;
  let json = false;
  const okWords: string[] = [];
  let inOk = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--by") {
      const value = argv[++i];
      if (value == null) throw new Error("--by 后面要跟窗口名（启动那句话里给的，比如 Claude-3）");
      by = value;
      inOk = false;
    } else if (flag === "--ok") {
      inOk = true;
    } else if (flag === "--coding") {
      coding = true;
      inOk = false;
    } else if (flag === "--json") {
      json = true;
      inOk = false;
    } else if (flag.startsWith("--")) {
      throw new Error(`不认识的参数 ${flag}。${CLI_USAGE}`);
    } else if (inOk) {
      okWords.push(flag);
    } else if (target == null) {
      target = flag;
    } else {
      throw new Error(`多了一个参数 ${flag}。${CLI_USAGE}`);
    }
  }
  if (!target) throw new Error(`${command} 缺捆号或条目 id（启动那句话里有）。${CLI_USAGE}`);
  if (!by) throw new Error(`${command} 缺 --by 窗口名（启动那句话里有，比如 --by Claude-3）`);
  const args: CliArgs = { command, target, by, coding, json, attach: [] };
  if (command === "done") {
    const ok = okWords.join(" ").trim();
    if (!ok) throw new Error('done 缺 --ok "用户原话"：先把做了啥、怎么验告诉用户，等他说可以，再把他的原话放进来');
    args.ok = ok;
  }
  return args;
}

/** 领到活以后给 AI 看的整段话。🚨 所有 AI（Claude/Codex/Pi/Hermes）看到的都是这一份，规矩只在这里写一次。 */
export function formatClaimMessage(
  reply: { item: CliRecord | null; prompt: string | null; position: number; total: number; remaining: number; busy: string[] },
  ctx: { cli: string; target: string; by: string; coding: boolean },
): string {
  const run = (rest: string) => `node "${ctx.cli}" ${rest}`;
  if (!reply.item) {
    const busy = reply.busy.length ? `还有 ${reply.busy.join("、")} 在干。` : "";
    return `【看板领活】${ctx.target} 没有可领的了。${busy}跟用户说一声这边的活领完了就行。`;
  }
  const where = reply.total > 1 ? `这一捆的第 ${reply.position}/${reply.total} 条` : "这一条";
  const id = reply.item.id;
  return [
    `【看板领活】你是 ${ctx.by}。领到${where}，看板上已经标成「${ctx.by} 在干」，别的窗口领不走。`,
    "",
    reply.prompt ?? "",
    "",
    "—— 干活规矩（所有 AI 都一样）——",
    "1. 一次只干这一条，这一捆里别的条先别碰。",
    "2. 干完先别删：把做了什么、改了哪些、怎么验，讲给用户听，请他自己验一下。",
    "3. 用户亲口说「可以」以后，把他的原话放进 --ok，敲：",
    `   ${run(`done ${id} --by ${ctx.by} --ok "他的原话"`)}`,
    `4. 删完接着领下一条（这一捆还剩 ${reply.remaining} 条没人领）：`,
    `   ${run(`next ${ctx.target} --by ${ctx.by}${ctx.coding ? " --coding" : ""}`)}`,
    "5. 干不下去、要换人：",
    `   ${run(`release ${id} --by ${ctx.by}`)}`,
  ].join("\n");
}

// ── 服务端路由 + 校验（纯函数，HTTP 层只做收发，逻辑全在这测） ──

export interface CliRequestContext {
  token: string;
  store: CliStoreAdapter;
  onChanged?: () => void;
}

export interface CliReply {
  status: number;
  body: unknown;
}

/** 处理一个请求。token 不对一律 403（防本机其他进程乱写）；逻辑错误 400；未知端点 404。 */
export function handleCliRequest(
  method: string,
  urlPath: string,
  body: unknown,
  authHeader: string | undefined,
  ctx: CliRequestContext,
): CliReply {
  if (authHeader !== `Bearer ${ctx.token}`) {
    return { status: 403, body: { ok: false, error: "token 不对（CLI 会自动读 cli-port.json，别手拼）" } };
  }
  const path = urlPath.split("?")[0];
  if (method === "POST" && path === "/add") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const text = String(raw.text ?? "").trim();
    if (!text) return { status: 400, body: { ok: false, error: "内容不能为空" } };
    const attachSources = collectAttachSources(raw.attach);
    const record = ctx.store.add({
      text,
      url: raw.url ? String(raw.url) : null,
      assignee: raw.assignee ? String(raw.assignee) : null,
      dedupeKey: raw.dedupeKey ? String(raw.dedupeKey) : null,
    });
    let attachError: CliReply | null = null;
    if (attachSources.length) {
      const addAttachment = ctx.store.addAttachment;
      if (typeof addAttachment !== "function") {
        attachError = { status: 500, body: { ok: false, error: "看板还不支持贴图（主进程未接线 addAttachment）" } };
      } else {
        for (const src of attachSources) {
          try {
            const updated = addAttachment(record.id, src);
            if (!updated) {
              attachError = { status: 404, body: { ok: false, error: "条目不在了，贴图没加上" } };
              break;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attachError = { status: 400, body: { ok: false, error: message } };
            break;
          }
        }
      }
    }
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓，别影响回包 */
    }
    if (attachError) return attachError;
    return { status: 200, body: { ok: true, id: record.id } };
  }
  if (method === "POST" && path === "/handoff") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const text = String(raw.text ?? "").trim();
    if (!text) return { status: 400, body: { ok: false, error: "交接单标题不能为空（两行内说清做了啥、交了啥）" } };
    const record = ctx.store.add({
      text,
      url: null,
      assignee: raw.assignee ? String(raw.assignee) : null,
      dedupeKey: null,
      kind: "handoff",
      detail: raw.detail ? String(raw.detail) : null,
    });
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
    return { status: 200, body: { ok: true, id: record.id, kind: record.kind } };
  }
  if (method === "POST" && path === "/remove") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const id = String(raw.id ?? "").trim();
    if (!id) return { status: 400, body: { ok: false, error: "缺条目 id" } };
    const removed = ctx.store.remove(id);
    if (!removed) return { status: 404, body: { ok: false, error: "没找到这条（可能已删）" } };
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
    return { status: 200, body: { ok: true } };
  }
  if (method === "GET" && path === "/list") {
    const query = new URL(urlPath, "http://localhost").searchParams;
    const to = query.get("to");
    const handoffOnly = query.get("handoff") === "1";
    const items = ctx.store
      .list()
      .filter((record) => (handoffOnly ? record.kind === "handoff" : true))
      .filter((record) =>
        to ? (record.assignee ?? "").toLowerCase() === to.toLowerCase() : true,
      )
      .map(withAttachmentPaths);
    return { status: 200, body: { ok: true, items } };
  }
  if (method === "POST" && (path === "/next" || path === "/done" || path === "/release")) {
    return handleClaimRequest(path, (body ?? {}) as Record<string, unknown>, ctx);
  }
  return { status: 404, body: { ok: false, error: "未知端点（POST /add | /handoff | /remove | /next | /done | /release | GET /list）" } };
}

/** 领活三件套。store 抛的错（不是你领的、缺用户原话、找不到）原样回给 AI，400。 */
function handleClaimRequest(path: string, raw: Record<string, unknown>, ctx: CliRequestContext): CliReply {
  const store = ctx.store;
  const by = String(raw.by ?? "").trim();
  if (!by) return { status: 400, body: { ok: false, error: "缺 --by 窗口名" } };
  const changed = () => {
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
  };
  try {
    if (path === "/next") {
      if (!store.claimNext) return { status: 500, body: { ok: false, error: "看板还不支持领活（主进程未接线）" } };
      const target = String(raw.target ?? "").trim();
      if (!target) return { status: 400, body: { ok: false, error: "缺捆号或条目 id" } };
      const template = raw.coding ? store.template?.("coding") ?? null : null;
      if (raw.coding && !template) return { status: 400, body: { ok: false, error: "要求模板「带编程」找不到了（看板 ⚙ 设置里打开要求模板夹看看）" } };
      const got = store.claimNext(target, by);
      changed();
      return {
        status: 200,
        body: {
          ok: true,
          item: got.record,
          prompt: got.record ? composeForAgent(template, got.record) : null,
          position: got.position,
          total: got.total,
          remaining: got.remaining,
          busy: got.busy,
        },
      };
    }
    const id = String(raw.id ?? "").trim();
    if (!id) return { status: 400, body: { ok: false, error: "缺条目 id" } };
    if (path === "/done") {
      if (!store.done) return { status: 500, body: { ok: false, error: "看板还不支持 done（主进程未接线）" } };
      const userOk = String(raw.ok ?? "").trim();
      if (!userOk) return { status: 400, body: { ok: false, error: "缺用户确认：先把做了啥、怎么验告诉用户，等他说可以，再把他的原话放进 --ok" } };
      store.done(id, by, userOk);
      changed();
      return { status: 200, body: { ok: true } };
    }
    if (!store.release) return { status: 500, body: { ok: false, error: "看板还不支持 release（主进程未接线）" } };
    const current = store.list().find((r) => r.id === id);
    if (!current) return { status: 404, body: { ok: false, error: "没找到这条（可能已经删了）" } };
    if (current.claimedBy && current.claimedBy !== by) {
      return { status: 400, body: { ok: false, error: `这条是 ${current.claimedBy} 领的，不是你的，放不回去` } };
    }
    store.release(id);
    changed();
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

function collectAttachSources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

/** list 给 Agent 的是完整路径，拿去就能读图；库里仍只存文件名。 */
function withAttachmentPaths(record: CliRecord): CliRecord {
  const names = record.attachments ?? [];
  return {
    ...record,
    attachments: names.map((name) => join(attachmentsRoot(), basename(name))),
  };
}

// ── HTTP 层（随主进程活；启动失败只记日志不连坐） ──

let activeServer: Server | null = null;

/** 启动本机回环 CLI 服务：随机端口 + 随机 token 写 cli-port.json，CLI 每次自己读。 */
export function startBookmarkCliServer(deps: BookmarkCliDeps): BookmarkCliServerHandle {
  try {
    // 幂等：旧的先关（initBookmarkPanel 有幂等闸，这是二道保险）。
    if (activeServer) {
      try {
        activeServer.close();
      } catch {
        /* 关旧的失败无所谓 */
      }
      activeServer = null;
    }
    const token = randomBytes(16).toString("hex");
    const ctx: CliRequestContext = { token, store: deps.store, onChanged: deps.onChanged };
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          let body: unknown = undefined;
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "body 不是合法 JSON" }));
              return;
            }
          }
          const reply = handleCliRequest(req.method ?? "GET", req.url ?? "/", body, req.headers.authorization, ctx);
          res.writeHead(reply.status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(reply.body));
        } catch (error) {
          log.出事("CLI 请求处理炸了（已兜住）", error, "cli");
          try {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "看板内部错误" }));
          } catch {
            /* 响应头都发不出去就算了 */
          }
        }
      });
    });
    server.on("error", (error) => log.出事("CLI 服务出错（不影响看板本体）", error, "cli"));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        writeJsonAtomic(bookmarkCliPortPath(), { port, token });
        log.记(`CLI 接入服务就绪（127.0.0.1:${port}，端口已写 cli-port.json）`, "cli");
      } catch (error) {
        log.出事("cli-port.json 写盘失败（CLI 会连不上，看板本体不受影响）", error, "cli");
      }
    });
    activeServer = server;
    return {
      stop: () => {
        try {
          server.close();
        } catch {
          /* 收尾失败无所谓 */
        }
        if (activeServer === server) activeServer = null;
      },
    };
  } catch (error) {
    log.出事("CLI 接入服务启动失败（看板仍可用，只是命令行连不上）", error, "cli");
    return { stop: () => undefined };
  }
}
