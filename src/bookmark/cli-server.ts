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
}

export interface CliStoreAdapter {
  add(input: { text: string; url: string | null; assignee: string | null; dedupeKey: string | null; detail?: string | null; kind?: "note" | "handoff"; attachments?: string[] }): CliRecord;
  list(): CliRecord[];
  /** 删除一条（交接完自删用）；没找到返回 false。 */
  remove(id: string): boolean;
  /** 拷源图进 attachments\ 并追到该条；没这条返 null。接线在 panel-window 适配器。 */
  addAttachment?(id: string, sourcePath: string): CliRecord | null;
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
  command: "add" | "list" | "handoff" | "remove";
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
  + 'handoff "标题" [--to Agent名] [--detail 详情] | remove <条目id>';

/** 解析命令行参数。add/handoff 的位置参数拼接为内容；--to 省略 = 进待定区。参数不对抛错（消息是给 agent 看的用法）。 */
export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0];
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
  return { status: 404, body: { ok: false, error: "未知端点（POST /add | POST /handoff | POST /remove | GET /list）" } };
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
