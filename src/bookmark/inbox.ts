// 收信+回执接线（2026-09-10 接线联调）：连 ntfy 邮局收手机发来的记录 → 入书签库 → 发「已收录」回执 → 通知看板刷新。
// 逻辑移植自 通道（阿里云ntfy·部署与收信）\receiver\receiver.js（行为对齐，那边的单测是正本参照）。
//
// 🚨 隔离铁律：一切网络异常在这里内部消化（指数退避重连+吞错记日志），绝不抛给调用方、绝不连坐桌宠本体。
// 🚨 「最后消息 id 作 since 续读」是断线补收的命根子（手机离线发的消息靠它补收），别动。
//
// 协议（跟手机端 lib/core/models.dart 对齐）：ntfy message 字段装业务 JSON 字符串：
//   {"v":1,"type":"note|bookmark|task|cmd","content":"...","assignee":"","ts":123,"dedupeKey":"..."}
// 兼容一层：手机端 publish 把 ntfy 发布 JSON（topic/title/message）整包 POST 到 /{topic} 时，
// 邮局把整包当 message 存。外层没有 dedupeKey，内层 message 才是业务 JSON；回执也必须用内层。
// type=cmd 只入库绝不执行（手机端约定）；回执 = 原业务 JSON 原样回发到 receipt 主题，手机端按 dedupeKey 对账。
// type=op（设定19）＝手机上挪组 / 删条的命令：照做（board-sync 的 parsePhoneOp / applyPhoneOp），不入库，回执照发。

import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { createLogger } from "../shared/log";
import { bookmarkNtfyConfigPath } from "../shared/paths";
import type { BookmarkStore } from "./store";
import { applyPhoneOp, parsePhoneOp } from "./board-sync";

const log = createLogger("bookmark");

/** 首次连接的补收起点：邮局缓存 7 天，手机在电脑端没开时发的消息靠这个补收。 */
const DEFAULT_SINCE = "168h";
const MAX_BACKOFF_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 15_000;

export interface NtfyInboxConfig {
  /** 邮局地址，不带尾斜杠（如 http://116.62.217.189）。 */
  server: string;
  /** 上行主题（手机只写）。 */
  upTopic: string;
  /** 回执主题（电脑只写）。 */
  receiptTopic: string;
  user: string;
  pass: string;
  /** 首次连接补收起点（时长如 168h 或某消息 id）；缺省 168h。 */
  since?: string;
  /** 整板发给手机的主题（电脑只写、手机只读，设定19）；缺省 bookmark-board。 */
  boardTopic: string;
}

/** 从 <appDataRoot>\bookmark\ntfy.json 读邮局配置。缺文件/坏档/缺必填字段一律返回 null（记日志，不启动收信，不炸）。 */
export function readInboxConfig(path?: string): NtfyInboxConfig | null {
  const configPath = path ?? bookmarkNtfyConfigPath();
  if (!existsSync(configPath)) {
    log.记(`收信配置不存在（${configPath}），收信模块不启动（看板本地功能不受影响）`, "inbox");
    return null;
  }
  try {
    // 剥 UTF-8 BOM：Windows 下记事本/PowerShell 写文件常带 BOM，不剥 JSON.parse 直接炸。
    const text = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(text);
    const raw = (parsed ?? {}) as Record<string, unknown>;
    const server = typeof raw.server === "string" ? raw.server.trim().replace(/\/+$/, "") : "";
    const upTopic = typeof raw.upTopic === "string" ? raw.upTopic.trim() : "";
    const receiptTopic = typeof raw.receiptTopic === "string" ? raw.receiptTopic.trim() : "";
    const user = typeof raw.user === "string" ? raw.user : "";
    const pass = typeof raw.pass === "string" ? raw.pass : "";
    const since = typeof raw.since === "string" && raw.since.trim() ? raw.since.trim() : undefined;
    if (!server || !upTopic || !receiptTopic || !user || !pass) {
      log.出事(`收信配置缺必填字段（server/upTopic/receiptTopic/user/pass），收信模块不启动`, undefined, "inbox");
      return null;
    }
    const boardTopic = typeof raw.boardTopic === "string" && raw.boardTopic.trim() ? raw.boardTopic.trim() : "bookmark-board";
    return { server, upTopic, receiptTopic, user, pass, since, boardTopic };
  } catch (error) {
    log.出事("收信配置解析失败，收信模块不启动", error, "inbox");
    return null;
  }
}

export interface BookmarkInboxOptions {
  store: BookmarkStore;
  /** 每当有消息入库（或去重命中）后回调一次——面板用它触发刷新。回调抛错照样吞。 */
  onInboxChanged?: () => void;
  /** 配置文件路径（测试注入用）；缺省读 <appDataRoot>\bookmark\ntfy.json。 */
  configPath?: string;
  /** 重连基础退避毫秒（默认1000，测试用小值）。 */
  reconnectBaseMs?: number;
  /** 日志注入（测试静音用）。 */
  logSink?: (message: string) => void;
}

export interface BookmarkInboxHandle {
  stop: () => void;
}

/** 启动收信：读配置 → 订阅上行主题 → 逐条入库+回执。配置缺失时返回"空转"句柄（stop 可安全调）。 */
export function startBookmarkInbox(options: BookmarkInboxOptions): BookmarkInboxHandle {
  try {
    const config = readInboxConfig(options.configPath);
    if (!config) return { stop: () => undefined };
    return subscribe(config, options);
  } catch (error) {
    // 理论到不了（subscribe 内部已兜），兜底防万一。
    log.出事("收信模块启动异常（看板仍可用，只是收不到手机消息）", error, "inbox");
    return { stop: () => undefined };
  }
}

let activeHandle: BookmarkInboxHandle | null = null;

/** 启动（幂等：先停旧的再启新的）。app 退出时配 stopBookmarkInbox() 收尾。 */
export function ensureBookmarkInboxStarted(options: BookmarkInboxOptions): void {
  stopBookmarkInbox();
  activeHandle = startBookmarkInbox(options);
}

export function stopBookmarkInbox(): void {
  try {
    activeHandle?.stop();
  } catch (error) {
    log.出事("收信模块停止失败（不影响退出）", error, "inbox");
  }
  activeHandle = null;
}

// ── 订阅层（照 receiver.js 移植：断线指数退避重连 + lastId since 续读补收） ──

function subscribe(config: NtfyInboxConfig, options: BookmarkInboxOptions): BookmarkInboxHandle {
  const sink = options.logSink ?? ((message: string) => log.记(message, "inbox"));
  const baseMs = typeof options.reconnectBaseMs === "number" ? options.reconnectBaseMs : 1000;
  const authHeader = "Basic " + Buffer.from(`${config.user}:${config.pass}`).toString("base64");

  let stopped = false;
  let lastId: string | undefined = undefined; // 断线补收的命根子：重连时从最后一条消息之后续读
  let currentReq: http.ClientRequest | undefined = undefined;
  let reconnectTimer: NodeJS.Timeout | undefined = undefined;
  let attempt = 0;

  const scheduleReconnect = (reason: string): void => {
    if (stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** attempt) + Math.floor(Math.random() * 250);
    attempt += 1;
    sink(`收信连接断开（${reason}），${delay}ms 后第 ${attempt} 次重连`);
    reconnectTimer = setTimeout(connect, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    const sinceParam = lastId ?? config.since ?? DEFAULT_SINCE;
    const url = `${config.server}/${config.upTopic}/json?since=${encodeURIComponent(sinceParam)}`;
    try {
      const req = pickHttpModule(config.server).get(url, { headers: { Authorization: authHeader } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect(`HTTP ${res.statusCode}`);
          return;
        }
        attempt = 0; // 建立成功，退避归零
        pipeLines(
          res,
          (line) => {
            if (stopped) return;
            let evt: NtfyEvent;
            try {
              evt = JSON.parse(line) as NtfyEvent;
            } catch {
              sink(`坏行跳过: ${line.slice(0, 80)}`);
              return;
            }
            if (evt && evt.id) lastId = evt.id; // open/message 都推进游标
            if (evt && evt.event === "message") {
              try {
                handleMessage(evt);
              } catch (error) {
                log.出事("收信处理抛错（已吞掉，不影响继续收）", error, "inbox");
              }
            }
          },
          () => scheduleReconnect("流结束"),
          (error) => scheduleReconnect(describeError(error)),
        );
      });
      currentReq = req;
      req.on("error", (error) => scheduleReconnect(describeError(error)));
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : "连接异常");
    }
  };

  const handleMessage = (evt: NtfyEvent): void => {
    const raw = typeof evt.message === "string" ? evt.message : "";
    const decoded = tryDecodePayload(raw);
    if (!decoded) {
      log.出事(`非协议消息跳过（不入库不回执）: ${raw.slice(0, 80)}`, undefined, "inbox");
      return;
    }
    const payload = decoded.payload;
    // 手机命令（设定19）：挪组 / 删条照做，不入库；回执照发，手机靠回执知道命令到了。
    const op = parsePhoneOp(payload.raw);
    if (op) {
      sink(`手机命令：${applyPhoneOp(options.store, op)}`);
      try {
        options.onInboxChanged?.();
      } catch {
        /* 通知刷新失败无所谓 */
      }
      void sendReceipt(config, decoded.receiptMessage, sink);
      return;
    }
    // 入库（dedupeKey 去重是手机端离线重发的防重复闸；重复投递 add 幂等返回旧记录）。
    // type=cmd 也只入库绝不执行（手机端约定）。
    options.store.add({
      text: payload.content,
      assignee: payload.assignee || null,
      dedupeKey: payload.dedupeKey,
    });
    sink(`已收录（${payload.type}·assignee=${payload.assignee || "待定"}）`);
    // 先刷面板（不回执也该刷），再发回执（fire-and-forget：回执失败只记日志，手机端下次开 APP 对账补拉）。
    try {
      options.onInboxChanged?.();
    } catch {
      /* 通知刷新失败无所谓，Ctrl+R 还能手动刷 */
    }
    // 回执必须是内层业务 JSON：手机端按 dedupeKey 对账；外层 ntfy 发布包没有顶层 dedupeKey。
    void sendReceipt(config, decoded.receiptMessage, sink);
  };

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      currentReq?.destroy();
    },
  };
}

interface NtfyEvent {
  id?: string;
  event?: string;
  message?: string;
}

interface BusinessPayload {
  type: string;
  content: string;
  assignee: string;
  dedupeKey: string;
  /** 原始字段（type=op 的命令要读 op / id / assignee）。 */
  raw: Record<string, unknown>;
}

interface DecodedPayload {
  payload: BusinessPayload;
  /** 回执原样回发用：永远是内层业务 JSON（有顶层 dedupeKey），不是 ntfy 发布包。 */
  receiptMessage: string;
}

/** 解析业务 JSON（照手机端 LedgerEntry.tryDecodePayload 的等价校验：dedupeKey 必须是非空字符串）。垃圾数据返回 null。
 *  兼容一层：手机端 publish 把 ntfy 发布 JSON（topic/title/message）整包 POST 到 /{topic}，
 *  邮局把整包当 message 存。外层没有 dedupeKey，内层 message 才是业务 JSON。 */
function tryDecodePayload(raw: string): DecodedPayload | null {
  const direct = decodeBusiness(raw);
  if (direct) return { payload: direct, receiptMessage: raw };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const nested = (parsed as Record<string, unknown>).message;
    if (typeof nested !== "string" || !nested) return null;
    const inner = decodeBusiness(nested);
    if (!inner) return null;
    return { payload: inner, receiptMessage: nested };
  } catch {
    return null;
  }
}

function decodeBusiness(raw: string): BusinessPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const map = parsed as Record<string, unknown>;
    const dedupeKey = map.dedupeKey;
    if (typeof dedupeKey !== "string" || !dedupeKey) return null;
    return {
      type: typeof map.type === "string" ? map.type : "note",
      content: typeof map.content === "string" ? map.content : "",
      assignee: typeof map.assignee === "string" ? map.assignee : "",
      dedupeKey,
      raw: map,
    };
  } catch {
    return null;
  }
}

/** 发「已收录」回执：原业务 JSON 原样回发到回执主题。永不抛——结果记日志。 */
async function sendReceipt(config: NtfyInboxConfig, originalMessage: string, sink: (message: string) => void): Promise<void> {
  try {
    const res = await fetch(`${config.server}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${config.user}:${config.pass}`).toString("base64"),
      },
      body: JSON.stringify({
        topic: config.receiptTopic,
        title: "已收录",
        message: originalMessage,
        tags: ["white_check_mark"],
      }),
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
    if (!res.ok) {
      sink(`回执发送失败：HTTP ${res.status}`);
      return;
    }
    sink("回执已发（已收录）");
  } catch (error) {
    sink(`回执发送失败（${error instanceof Error ? error.message : String(error)}），手机端下次对账会补拉`);
  }
}

// ── HTTP 流工具（照 receiver.js 原样移植，别动） ──

function pickHttpModule(server: string): typeof http | typeof https {
  return server.startsWith("https:") ? https : http;
}

/** 取错误描述：Node 网络错误优先取 code（如 ECONNRESET），普通 Error 取 message。 */
function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code) return code;
  return error instanceof Error ? error.message : "未知错误";
}

// 注：不用 readline——实测（2026-09-09）挂上 readline 后，服务端 RST 时流的 error 事件会丢失变成未捕获异常，
// 自己按 \n 切分行为完全可控。
function pipeLines(
  res: http.IncomingMessage,
  onLine: (line: string) => void,
  onEnd: () => void,
  onError: (error: Error) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  res.on("data", (chunk) => {
    buf += decoder.write(chunk);
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  });
  res.on("end", () => {
    const tail = (buf + decoder.end()).trim();
    if (tail) onLine(tail);
    onEnd();
  });
  res.on("error", onError);
}
