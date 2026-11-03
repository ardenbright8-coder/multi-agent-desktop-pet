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
import { parseDispatchArgs, type DispatchInput } from "./dispatch-cli";
import { formatBrief, formatShow, indexBoard, parseShowSpec, type BoardNames } from "./board-index";
import { imagesForAgent } from "./inline-images";
import { checklistProgress, formatPending, lastProgress, parseChecklist, type ChecklistItem } from "./checklist";
import { HANDED_OUT } from "./store";
import { similarHandoffs, type HoldMark } from "./handoff-hygiene";

/** bookmark-cli.mjs 交清单前先在本地查格式，写错了不用连看板就报。 */
export { parseChecklist };

const log = createLogger("bookmark");

export interface CliRecord {
  id: string;
  text: string;
  url: string | null;
  assignee: string | null;
  dedupeKey: string | null;
  detail: string | null;
  kind: "note" | "handoff" | "dispatch";
  /** 派活单批号（设定23）；老适配器可以不给。 */
  batchId?: string | null;
  /** 交给哪套系统（根／燊一修，2026-10-27）；没标是 null，老适配器可以不给。 */
  forSystem?: string | null;
  /** 交接单管着哪几条（条目 id，2026-10-28）：done 时一起删。 */
  links?: string[];
  /** 打勾清单 / 边干边记的进度（2026-10-28）；老适配器可以不给。 */
  checklist?: ChecklistItem[];
  progress?: string[];
  /** 窗口最后一次碰它 / 挂起（2026-11-03）；老适配器可以不给。 */
  touchedAt?: string;
  claimedAt?: string | null;
  hold?: HoldMark;
  /** list 出口会把文件名展开成 attachmentsRoot 下的完整路径。 */
  attachments: string[];
  createdAt: string;
  /** 捆号 / 谁领走了（设定15）；老适配器可以不给。 */
  bundleId?: string | null;
  claimedBy?: string | null;
  /** 睡觉档 AI 写的大白话报告（设定18）；老适配器可以不给。 */
  report?: string | null;
}

/** 领活结果（store.claimNext 同形）：record 为 null = 没活可领，busy 是正在干的窗口名。 */
export interface CliClaim {
  record: CliRecord | null;
  position: number;
  total: number;
  remaining: number;
  busy: string[];
  bundleId?: string;
  coordinator?: string;
}

export interface CliStoreAdapter {
  add(input: { text: string; url: string | null; assignee: string | null; dedupeKey: string | null; detail?: string | null; kind?: "note" | "handoff"; attachments?: string[]; forSystem?: string | null; links?: string[] }): CliRecord;
  /** 交接单接力（2026-10-28）：这个窗口领着的交接单 / 新单顶掉旧单 / 边干边记一句。 */
  heldHandoff?(by: string): CliRecord | undefined;
  supersede?(oldId: string, newId: string): void;
  appendProgress?(id: string, by: string, text: string): CliRecord;
  /** 打勾清单（2026-10-28）：交一份整理好的清单 / 勾一项（拨开关，全勾完自动收掉）。 */
  setChecklist?(id: string, items: ChecklistItem[], by: string): CliRecord;
  tick?(id: string, no: string, by: string | null): { record: CliRecord; done: number; total: number; closed: boolean; linksRemoved: number };
  /** 挂起 / 取消挂起（2026-11-03 用户：先不做、等我说做再做的另放）。 */
  hold?(id: string, by: string, why: string): CliRecord;
  unhold?(id: string): CliRecord;
  /** 「原话」那份副本的完整路径（有清单才有）；没有返回 null。 */
  originalFile?(id: string): string | null;
  list(): CliRecord[];
  /** 删除一条（交接完自删用）；没找到返回 false。 */
  remove(id: string): boolean;
  /** 拷源图进 attachments\ 并追到该条；没这条返 null。接线在 panel-window 适配器。 */
  addAttachment?(id: string, sourcePath: string): CliRecord | null;
  /** 领活三件套（设定15）：领下一条 / 用户说可以才删 / 放回去。 */
  claimNext?(target: string, by: string): CliClaim;
  done?(id: string, by: string, userOk: string): CliRecord;
  release?(id: string): CliRecord | null;
  /** 睡觉档（设定18）：按组领 / 写大白话报告 / 看板现在是哪一档。 */
  claimInGroup?(group: string, by: string): CliClaim;
  report?(id: string, by: string, text: string): CliRecord;
  mode?(): "day" | "sleep";
  /** 要求模板原文：coding = 「带编程」那份；没有返回 null。 */
  template?(name: "coding"): string | null;
  dispatch?(input: DispatchInput): unknown;
  bundleInfo?(id: string | null | undefined): { id: string; coordinator: string } | undefined;
  /** 派活单（设定23）：一批 1～3 张，assignee 空＝默认 Pi 组（适配器里认组名）。 */
  addDispatchBatch?(cards: { text: string; detail: string | null; assignee: string }[]): CliRecord[];
  /** 一条一份小文件（设定24）：条目 id → 完整路径；没有就抛错。 */
  itemFile?(id: string): string;
  /** 命令行 launch（2026-10-16）：替用户点这批的「一键启动」；model＝开窗前替他在 Pi 里换成哪个。 */
  launchBatch?(id: string, coding: boolean, model: string | null): Promise<{
    launched: { name: string; label: string }[];
    conflicts: { a: string; b: string; files: string[] }[];
    missing: string[];
    skipped: { name: string; reason: string }[];
    model: string | null;
  }>;
  /** Pi 能挑的模型和上次挑的那个。 */
  piModels?(): { models: string[]; current: string | null };
  /** 按号码读（2026-10-13）：组名单（跟看板同序）、AI 写的小标题、捆名。没接就只能 list --json。 */
  boardNames?(): BoardNames & { agents: string[] };
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
  command: "add" | "list" | "handoff" | "remove" | "next" | "done" | "release" | "report" | "log" | "checklist" | "tick" | "hold" | "unhold" | "dispatch" | "show" | "paihuo" | "launch";
  /** handoff 的 --new：跟已有交接单像也照样写（确认是另一件事）。 */
  force?: boolean;
  /** tick 要勾的项号（可以一次几个：勾 <单号> 2.1 2.2）。 */
  nos?: string[];
  /** handoff 的 --closes：这张交接单管着哪几条（号码或 id，逗号隔开），done 时一起删。 */
  closes?: string;
  /** launch 的 Pi 模型（「供应商/模型」，不写就用 Pi 上次记的）。 */
  model?: string;
  /** paihuo 的单子文件路径（JSON，CLI 脚本自己读）。 */
  file?: string;
  /** show 的组名和号码（屏幕上看到的号：7、7-9、捆2）。 */
  group?: string;
  spec?: string[];
  payload?: DispatchInput;
  /** next/done/release/report 的对象：捆号或条目 id（next --to 组名时没有）。 */
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
  /** handoff 的 --for：交给哪套系统（根／燊一修）。 */
  forSystem?: string;
  json: boolean;
  /** add --attach 的源图片路径（可多次）。 */
  attach: string[];
}

const CLI_USAGE =
  '用法：bookmark-cli list [--to 组名] [--handoff]（只列号码和标题）| show <号码：7 / 7-9 / 7,8,9 / 捆2>（号码全板统一，只读点名的全文）| '
  + 'list [--to 组名] [--handoff] --json（整组原文，费字，少用）| add "内容" [--to Agent名] [--url 网址] [--attach 图片路径] [--json] | '
  + 'handoff "标题" [--to Agent名] [--detail 详情] [--for 系统名：交给另一套 Windows（根／燊一修）时才写] [--by 你的窗口名：你领着交接单时写，新单顶掉旧单] [--closes 号码,号码：这张管着的条目，done 时一起删] [--new：跟已有交接单像、确认是另一件事才加] | log <条目id> --by 窗口名 --text "一句进度" | remove <条目id> | '
  + '清单 <单号或id> --file 清单.md --by 窗口名（交整理好的打勾清单：- [ ] 1 那件事 ／ 缩进 - [ ] 1.1 小项）| 勾 <单号或id> 2.1 [2.2 …]（拨开关，再勾一次取消；全勾完单子自动收掉）| '
  + 'next <捆号或条目id> --by 窗口名 [--coding] | next --to 组名 --by 窗口名 | done <条目id> --by 窗口名 --ok "用户原话" | '
  + 'report <条目id> --by 窗口名 --text "大白话报告" | release <条目id> --by 窗口名 | '
  + '挂起 <单号或id> --why "他原话：先不做，等他说做再做" [--by 窗口名] | 取消挂起 <单号或id> | '
  + 'paihuo --file 单子.json [--to 组名]（派活单一批 1～3 张，不写组默认 Pi 组）| '
  + 'launch <号码> [--model 供应商/模型] [--coding]（替用户点这批的一键启动；他说「直接开」才用）';

/** 解析命令行参数。add/handoff 的位置参数拼接为内容；--to 省略 = 进待定区。参数不对抛错（消息是给 agent 看的用法）。 */
export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0];
  if (command === 'dispatch') return { command, payload: parseDispatchArgs(argv), json: argv.includes('--json'), attach: [] };
  if (command === "paihuo") {
    let file: string | undefined;
    let to: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--file") file = argv[++i];
      else if (flag === "--to") to = argv[++i];
      else if (flag !== "--json") throw new Error(`不认识的参数 ${flag}。写法：paihuo --file 单子.json [--to 组名]`);
    }
    if (!file) throw new Error("paihuo 缺 --file 单子.json（一批 1～3 张，格式见 AGENT_INTEGRATION.md 的派活单节）");
    return { command, file, to, json: argv.includes("--json"), attach: [] };
  }
  if (command === "launch") {
    let target: string | undefined;
    let model: string | undefined;
    let coding = false;
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--model") {
        model = argv[++i];
        if (!model) throw new Error("--model 后面要跟模型（Pi 里 Ctrl+E 能挑的那几个，写法 供应商/模型）");
      } else if (flag === "--coding") coding = true;
      else if (flag === "--json") continue;
      else if (flag.startsWith("--")) throw new Error(`不认识的参数 ${flag}。写法：launch <号码> [--model 供应商/模型] [--coding]`);
      else if (target == null) target = flag;
      else throw new Error(`多了一个参数 ${flag}。写法：launch <号码> [--model 供应商/模型] [--coding]`);
    }
    if (!target) throw new Error("launch 后面要跟这批里任一张的号码（或条目 id）：launch 18 --model openai-codex/gpt-6.1-sol");
    return { command, target, model, coding, json: argv.includes("--json"), attach: [] };
  }
  if (command === "next" || command === "done" || command === "release" || command === "report" || command === "log") return parseClaimArgs(command, argv);
  if (command === "清单" || command === "checklist" || command === "勾" || command === "tick") return parseChecklistArgs(command === "清单" || command === "checklist" ? "checklist" : "tick", argv);
  if (command === "挂起" || command === "hold" || command === "取消挂起" || command === "unhold") return parseHoldArgs(command === "挂起" || command === "hold" ? "hold" : "unhold", argv);
  if (command === "show") {
    // 号码全板统一（2026-10-15）：直接写号码就行；前面多写一个组名也认（不在那组时会提一句）
    const rest = argv.slice(1).filter((a) => a !== "--json");
    const named = rest[0] != null && !/^(捆)?\d/.test(rest[0]);
    const group = named ? rest[0] : "";
    const spec = named ? rest.slice(1) : rest;
    if (!spec.length) throw new Error("show 后面要跟号码：show 7 ／ show 7-9 ／ show 7,8,9 ／ show 捆2");
    parseShowSpec(spec); // 号码写错当场报，别等连上看板
    return { command, group, spec, json: argv.includes("--json"), attach: [] };
  }
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
    } else if (flag === "--by" && command === "handoff") {
      const value = argv[++i];
      if (value == null || !value.trim()) throw new Error("--by 后面要跟你的窗口名（领活时起的，如 Claude-3）");
      args.by = value.trim();
    } else if (flag === "--closes" && command === "handoff") {
      const value = argv[++i];
      if (value == null || !value.trim()) throw new Error("--closes 后面要跟这张管着的号码，逗号隔开，如 --closes 01,08");
      args.closes = value.trim();
    } else if (flag === "--for" && command === "handoff") {
      const value = argv[++i];
      if (value == null || !value.trim()) throw new Error("--for 后面要跟交给哪套系统（根 / 燊一修），只写名字");
      args.forSystem = value.trim();
    } else if (flag === "--new" && command === "handoff") {
      args.force = true;
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

/** 领活几件套的参数：一个位置参数（捆号或条目 id）+ --by（必填）+ done 的 --ok（必填，用户原话）+ next 的 --coding / --to 组名
 *  + report 的 --text（必填，大白话报告）。--ok、--text 后面可以跟好几个词，拼成一句。 */
function parseClaimArgs(command: "next" | "done" | "release" | "report" | "log", argv: string[]): CliArgs {
  let target: string | undefined;
  let by: string | undefined;
  let to: string | undefined;
  let coding = false;
  let json = false;
  const okWords: string[] = [];
  const textWords: string[] = [];
  let inOk = false;
  let inText = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--by") {
      const value = argv[++i];
      if (value == null) throw new Error("--by 后面要跟窗口名（启动那句话里给的，比如 Claude-3）");
      by = value;
      inOk = false;
      inText = false;
    } else if (flag === "--to" && command === "next") {
      const value = argv[++i];
      if (value == null) throw new Error("--to 后面要跟组名（比如 Claude、「Pi Agent」要带引号）");
      to = value;
      inOk = false;
      inText = false;
    } else if (flag === "--ok") {
      inOk = true;
      inText = false;
    } else if (flag === "--text" && (command === "report" || command === "log")) {
      inText = true;
      inOk = false;
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
    } else if (inText) {
      textWords.push(flag);
    } else if (target == null) {
      target = flag;
    } else {
      throw new Error(`多了一个参数 ${flag}。${CLI_USAGE}`);
    }
  }
  if (!target && !to) throw new Error(`${command} 缺捆号或条目 id（启动那句话里有）。${CLI_USAGE}`);
  if (!by) throw new Error(`${command} 缺 --by 窗口名（启动那句话里有，比如 --by Claude-3）`);
  const args: CliArgs = target ? { command, target, by, coding, json, attach: [] } : { command, to, by, coding, json, attach: [] };
  if (command === "log") {
    const text = textWords.join(" ").trim();
    if (!text) throw new Error('log 缺 --text "一句进度"：刚干完了啥、下一步干啥');
    args.text = text;
  }
  if (command === "report") {
    const text = textWords.join(" ").trim();
    if (!text) throw new Error('report 缺 --text "大白话报告"：做了啥、改了哪些、怎么验的、还有啥没弄完');
    args.text = text;
  }
  if (command === "done") {
    const ok = okWords.join(" ").trim();
    if (!ok) throw new Error('done 缺 --ok "用户原话"：先把做了啥、怎么验告诉用户，等他说可以，再把他的原话放进来');
    args.ok = ok;
  }
  return args;
}

/** 打勾清单两个命令（2026-10-28）：清单 <单号> --file 清单.md --by 窗口名；勾 <单号> 2.1 [2.2 …] [--by 窗口名]。
 *  单号是屏幕上的号码或条目 id，看板那边换。 */
function parseChecklistArgs(command: "checklist" | "tick", argv: string[]): CliArgs {
  const name = command === "checklist" ? "清单" : "勾";
  let target: string | undefined;
  let by: string | undefined;
  let file: string | undefined;
  const nos: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--by") {
      by = argv[++i]?.trim();
      if (!by) throw new Error("--by 后面要跟你的窗口名（领活时起的，如 Claude-3）");
    } else if (flag === "--file" && command === "checklist") {
      file = argv[++i];
      if (!file) throw new Error("--file 后面要跟清单文件路径（md，一行一项 - [ ] 1 那件事）");
    } else if (flag === "--json") {
      continue;
    } else if (flag.startsWith("--")) {
      throw new Error(`不认识的参数 ${flag}。写法：${command === "checklist" ? "清单 <单号> --file 清单.md --by 窗口名" : "勾 <单号> 2.1 [2.2 …]"}`);
    } else if (target == null) {
      target = flag;
    } else if (command === "tick") {
      nos.push(...flag.split(/[,，、]/).map((x) => x.trim()).filter(Boolean));
    } else {
      throw new Error(`多了一个参数 ${flag}。写法：清单 <单号> --file 清单.md --by 窗口名`);
    }
  }
  if (!target) throw new Error(`${name} 后面要跟单号（屏幕上的号码，或领活那段话里的条目 id）`);
  if (command === "checklist") {
    if (!file) throw new Error("清单 缺 --file 清单.md：先把整理好的清单写成文件（一行一项 - [ ] 1 那件事，小项缩进两格 - [ ] 1.1）");
    if (!by) throw new Error("清单 缺 --by 窗口名（领活那段话里有，比如 --by Claude-3）");
    return { command, target, by, file, json: argv.includes("--json"), attach: [] };
  }
  if (!nos.length) throw new Error("勾 后面要跟项号：勾 <单号> 2.1（一次几项写 2.1 2.2）");
  return { command, target, by, nos, json: argv.includes("--json"), attach: [] };
}

/** 挂起两个命令（2026-11-03）：挂起 <单号> --why "为啥" [--by 窗口名]；取消挂起 <单号>。--why 后面几个词拼成一句。 */
function parseHoldArgs(command: "hold" | "unhold", argv: string[]): CliArgs {
  let target: string | undefined;
  let by: string | undefined;
  const why: string[] = [];
  let inWhy = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--by") {
      by = argv[++i]?.trim();
      if (!by) throw new Error("--by 后面要跟你的窗口名");
      inWhy = false;
    } else if (flag === "--why" && command === "hold") {
      inWhy = true;
    } else if (flag === "--json") {
      continue;
    } else if (flag.startsWith("--")) {
      throw new Error(`不认识的参数 ${flag}。写法：${command === "hold" ? '挂起 <单号> --why "他说先不做，等他说做再做"' : "取消挂起 <单号>"}`);
    } else if (inWhy) {
      why.push(flag);
    } else if (target == null) {
      target = flag;
    } else {
      throw new Error(`多了一个参数 ${flag}`);
    }
  }
  if (!target) throw new Error(`${command === "hold" ? "挂起" : "取消挂起"} 后面要跟单号（屏幕上的号码或条目 id）`);
  const text = why.join(" ").trim();
  if (command === "hold" && !text) throw new Error('挂起 缺 --why "为啥"：他原话怎么说的，比如「先不做，等他说做再做」');
  return { command, target, by, text, json: argv.includes("--json"), attach: [] };
}

/** 派活单文件（设定23）：JSON，一个数组或 { cards: [...] }，每张 { text 标题, detail 完整单子, to 组名 }（也认 标题/详情/组）。
 *  每张必须写一行「只许动：文件a；文件b」（不改文件写「只许动：无」），一键启动前靠它查两张单子撞没撞文件。 */
export function parsePaihuoCards(raw: string, defaultTo?: string): { text: string; detail: string | null; assignee: string }[] {
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`单子文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(data) ? data : (data as { cards?: unknown })?.cards;
  if (!Array.isArray(list) || !list.length) throw new Error("单子文件里没有单子：写成 [ {...}, {...} ] 或 { \"cards\": [ ... ] }");
  if (list.length > 3) throw new Error(`一批最多 3 张（一键最多开 3 个窗口），这里有 ${list.length} 张：多的拆成下一批`);
  return list.map((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const text = String(c.text ?? c["标题"] ?? "").trim();
    const detail = String(c.detail ?? c["详情"] ?? "").trim();
    const to = String(c.to ?? c["组"] ?? defaultTo ?? "").trim();
    if (!text) throw new Error(`第 ${i + 1} 张没写 text（标题：一句话说清这张干啥）`);
    if (!/(^|\n)\s*[-*]?\s*只许动\s*[:：]/.test(`${text}\n${detail}`)) {
      throw new Error(`第 ${i + 1} 张没写「只许动：文件a；文件b」那一行（不改文件写「只许动：无」）——一键启动前靠它查撞没撞文件`);
    }
    return { text, detail: detail || null, assignee: to };
  });
}

/** 领到活以后给 AI 看的整段话。🚨 所有 AI（Claude/Codex/Pi/Hermes）看到的都是这一份，规矩只在这里写一次。 */
export function formatClaimMessage(
  reply: { item: CliRecord | null; prompt: string | null; position: number; total: number; remaining: number; busy: string[]; mode?: "day" | "sleep"; cooperation?: boolean; bundleId?: string; coordinator?: string; itemFile?: string | null; originalFile?: string | null; lastProgress?: string | null },
  ctx: { cli: string; target?: string; group?: string; by: string; coding: boolean },
): string {
  // 长路径只给一次（2026-10-15 省字模板：原来同一条路径每段重复 4 遍），下面命令都写「看板 …」
  const run = (rest: string) => `看板 ${rest}`;
  const alias = `「看板」＝ node "${ctx.cli}"，下面的命令照抄时把「看板」换成这一串。`;
  const sleep = reply.mode === "sleep";
  if (reply.cooperation) {
    if (!reply.item) return `【看板派工】本捆没有待做条目，已报告的条目仍待审核；其他窗口在干：${reply.busy.join('、') || '无'}。停止，不删除记录、不自行打开其他助手。`;
    return [
      `【看板派工】${ctx.by} 已占住整捆 ${reply.bundleId}，一次只做当前第 ${reply.position}/${reply.total} 条。`,
      alias,
      reply.prompt ?? '',
      `先读看板派工技能正本：${ctx.cli.replace(/scripts[\\/]bookmark-cli\.mjs$/, 'skills（AI用看板的说明书）/Agent看板/看板派工.md')}。也可通过 dispatch skill 看板派工 查询。`,
      '执行窗口由用户自己开。不要启动子助手、其他模型进程或后台工兵。只改任务单指定范围，先自测再交报告；不修改原始需求，不伪造用户同意。',
      run(`report ${reply.item.id} --by "${ctx.by}" --text "改了哪些文件；运行了什么测试；结果；剩余问题"`),
      '报告会留为待审核，并送入指定调度窗口的收件箱；不会删除任务或释放整捆。下一步只领本捆下一条：',
      run(`next ${reply.bundleId} --by "${ctx.by}"`),
      `需要换人时明确放回整捆：${run(`dispatch release ${reply.bundleId} --by "${ctx.by}"`)}`,
    ].join('\n\n');
  }
  if (!reply.item) {
    const busy = reply.busy.length ? `还有 ${reply.busy.join("、")} 在干。` : "";
    const what = ctx.group ? `${ctx.group} 组` : ctx.target;
    return sleep
      ? `【看板领活】${what} 没有可领的了。${busy}这边的活都领完了，停下就行（用户在睡觉，不用跟他说）。`
      : `【看板领活】${what} 没有可领的了。${busy}跟用户说一声这边的活领完了就行。`;
  }
  const id = reply.item.id;
  const forSystem = reply.item.forSystem;
  const checklist = reply.item.checklist?.length ? reply.item.checklist : null;
  // 怎么记进度、怎么换窗口只在规矩里说一次（2026-10-28 审：原来开头一行、规矩里各说一遍，还互相打架）
  const linksLine = reply.item.links?.length ? `这张管着 ${reply.item.links.length} 条原始条目，单子收掉时一起删。` : "";
  const fileLine = [
    linksLine,
    forSystem ? `【交给 ${forSystem}】这张是写给「${forSystem}」那套 Windows 的。先认清你在哪套上（看你的底层设定或家目录），不是 ${forSystem} 就别干，照最后一条放回去，跟用户说一声。` : "",
    reply.itemFile ? `这条的单独文件（以后要再看，只读这一份）：${reply.itemFile}` : "",
  ].filter(Boolean).join(String.fromCharCode(10));
  // 派活单（设定23）：强模型拆好的活，同批几张同时开在不同窗口。两档一个样：干完交报告就停，调度审、用户测。
  if (reply.item.kind === "dispatch") {
    return [
      `【看板派活单】你是 ${ctx.by}。领到一张派活单，看板上已经标成「${ctx.by} 在干」，别的窗口领不走。`,
      fileLine,
      alias,
      "",
      reply.prompt ?? "",
      "",
      "—— 派活单规矩（所有 AI 都一样）——",
      "1. 只干这一张。只动单子里「只许动」写的文件，别的一行不碰——同一批还有别的窗口在干别的单子，碰了会互相覆盖。",
      "2. 自己干完：不开子 agent 帮你干活、不叫别的模型、不去领别的活。例外：单子本身就是考试、明写了要开受测会话（如每题一个 claude -p），照单子开、照单子的次数开，这不算派人。",
      "3. 干完先照单子里的验收标准自测；测过了用大白话交报告（改了哪些文件、跑了什么、结果、还有啥没弄完），敲：",
      `   ${run(`report ${id} --by ${ctx.by} --text "改了哪些文件；跑了什么；结果；剩余问题"`)}`,
      "   这张会标成「干完待审」，等派活的强模型审、用户测；别自己 done、别删。交完报告就停。",
      "4. 卡住两次还过不去、或者要动单子外的文件：别硬干，写进报告交上去，让调度定。",
      "5. 干不下去、要换人：",
      `   ${run(`release ${id} --by ${ctx.by}`)}`,
    ].filter((line, i) => i !== 1 || line).join(String.fromCharCode(10));
  }
  // 睡觉档一律按组往下领（这组干完为止）；日常档用什么领的就接着用什么领。
  const group = ctx.group ?? (sleep ? reply.item.assignee ?? "" : "");
  const nextCmd = group ? `next --to "${group}" --by ${ctx.by}` : `next ${ctx.target} --by ${ctx.by}`;
  const coding = ctx.coding ? " --coding" : "";
  const where = group
    ? `${group} 组的第 ${reply.position}/${reply.total} 条`
    : reply.total > 1 ? `这一捆的第 ${reply.position}/${reply.total} 条` : "这一条";
  // 有打勾清单（2026-10-28）：只吐没勾的几行＋最后一句进度，不吐整张、不吐原话。全勾完自动收，不用 done。
  if (checklist && !sleep) {
    const { done, total } = checklistProgress(checklist);
    return [
      `【看板领活】你是 ${ctx.by}。领到${where}，看板上已经标成「${ctx.by} 在干」，别的窗口领不走。`,
      ...(fileLine ? [fileLine] : []),
      alias,
      "",
      `【打勾清单 ${done}/${total}】还没勾的：`,
      formatPending(checklist),
      ...(reply.lastProgress ? [`最后一句进度：${reply.lastProgress}`] : []),
      "",
      ...checklistRules(id, ctx.by, firstPending(checklist)),
      ...(reply.originalFile ? [`5. 原话平时不读，清单对不上、出了问题才翻：${reply.originalFile}`] : []),
    ].join("\n");
  }
  // 睡觉档 + 有清单（2026-10-28 审）：照样只吐没勾的、一项项勾；他在睡觉没人商量，汇报用 report 挂在条目下面，接着领下一条
  if (checklist && sleep) {
    const { done, total } = checklistProgress(checklist);
    return [
      `【看板领活 · 🌙 睡觉档】你是 ${ctx.by}。领到${where}，看板上已经标成「${ctx.by} 在干」，别的窗口领不走。`,
      ...(fileLine ? [fileLine] : []),
      alias,
      "",
      `【打勾清单 ${done}/${total}】还没勾的：`,
      formatPending(checklist),
      ...(reply.lastProgress ? [`最后一句进度：${reply.lastProgress}`] : []),
      "",
      "—— 干活规矩（睡觉档、有清单的单子）——",
      `1. 照没勾的一项项干，干完一项马上勾：${run(`勾 ${id} ${firstPending(checklist)}`)}。卡住的项不勾，跳过接着干别的；碰到要他拍板、有风险的事（删东西、动系统、花钱、发出去）也当卡住。`,
      `2. 全勾完单子自动收掉，直接领下一条。没勾完的：照清单两层结构写汇报（✅ 做完 / ⏸ 做到一半 / ⛔ 做不了和原因，末尾写建议下一步），挂上等他早上看：${run(`report ${id} --by ${ctx.by} --text "汇报"`)}`,
      `3. 接着领下一条，一直干到没有可领的：${run(`${nextCmd}${coding}`)}`,
      `4. 额度快完、上下文快满：这张单子本身就是交接单。${run(`log ${id} --by ${ctx.by} --text "停在哪、下一步"`)}，再 ${run(`release ${id} --by ${ctx.by}`)}，然后停。`,
    ].join("\n");
  }
  if (sleep) {
    return [
      `【看板领活 · 🌙 睡觉档】你是 ${ctx.by}。领到${where}，看板上已经标成「${ctx.by} 在干」，别的窗口领不走。`,
      ...(fileLine ? [fileLine] : []),
      alias,
      "",
      reply.prompt ?? "",
      "",
      "—— 干活规矩（睡觉档，所有 AI 都一样）——",
      "用户在睡觉。你一条接一条往下干，他早上起来看你写的报告。",
      "1. 一次只干这一条。",
      "2. 不用等他说「可以」，也别删这条。干完用大白话写一段报告（做了啥、改了哪些、怎么验的、还有啥没弄完或要他拍板的），敲：",
      `   ${run(`report ${id} --by ${ctx.by} --text "你的报告"`)}`,
      "   这条会标成「✅ 干完待审」，报告挂在条目下面，他早上看了说可以才删。",
      `3. 写完接着领 ${group} 组下一条，一直干到没有可领的：`,
      `   ${run(`${nextCmd}${coding}`)}`,
      "4. 额度快用完、或者上下文快满了：先写交接单（干到哪了、下一步干啥、新窗口要带哪些文件），再把手上这条放回去，然后停：",
      `   ${run(`handoff "交接：一句话说清干到哪" --to "${group}" --detail "干到哪了、下一步、要带的文件"`)}`,
      `   ${run(`release ${id} --by ${ctx.by}`)}`,
      "5. 碰到要他拍板、有风险的事（删东西、动系统、花钱、发出去）：别干，写进报告等他早上定，接着领下一条。",
    ].join(String.fromCharCode(10));
  }
  const head = [
    `【看板领活】你是 ${ctx.by}。领到${where}，看板上已经标成「${ctx.by} 在干」，别的窗口领不走。`,
    ...(fileLine ? [fileLine] : []),
    alias,
    "",
    reply.prompt ?? "",
    // 进度单独一栏以后不在原话里了，换窗口接手要看到上一个窗口干到哪
    ...(reply.lastProgress ? ["", `最后一句进度：${reply.lastProgress}`] : []),
    "",
  ];
  // 日常档没清单（2026-10-28 用户：所有领活都走这个标准，不只交接单——普通条目干完没人消，板上堆了 30 多条）：
  // 先整理清单当第一步、不给 done 那套（Haiku 模拟时老规矩会盖过它、直接开干）。全勾完自动收。派活单上面已单独返回。
  return [
    ...head,
    "—— 【先整理清单】这张还没有打勾清单，先做这一步，别的活等它 ——",
    "1. 读上面的原话，整理成有编号的两层清单：一件事 - [ ] 1，下挂小项缩进两格 - [ ] 1.1，按包含关系分、不分大事小事。每项写详细：动哪个文件或哪一块、做到什么算完——接手的窗口只看清单、不看原话。",
    "2. 在对话里给用户看简述版（一项一句，编号跟清单一样），等他点头。",
    `3. 他点头后把详细版写成文件交进去：${run(`清单 ${id} --file 清单.md --by ${ctx.by}`)}`,
    "4. 交进去以后照「清单」命令回的规矩干。",
    `5. 干不下去、要换人：${run(`release ${id} --by ${ctx.by}`)}`,
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
  if (method === 'POST' && path === '/dispatch') {
    if (!ctx.store.dispatch) return { status: 501, body: { ok: false, error: '看板尚未接入派工功能' } };
    try {
      const result = ctx.store.dispatch((body ?? {}) as DispatchInput);
      if (!['list', 'messages', 'skills', 'skill'].includes(String((body as DispatchInput)?.action))) {
        try { ctx.onChanged?.(); } catch { /* 不影响数据结果 */ }
      }
      return { status: 200, body: result };
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }
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
    // 管哪几条（2026-10-28）：号码按看板现在的数法换成 id，id 原样认；对不上的整张不写，报回去
    const all = ctx.store.list();
    const links: string[] = [];
    const tokens = String(raw.closes ?? "").split(/[,，、\s]+/).filter(Boolean);
    if (tokens.length) {
      const rows = indexBoard(all, ctx.store.boardNames?.().agents ?? []).flatMap((g) => g.rows);
      const bad: string[] = [];
      for (const t of tokens) {
        const hit = /^\d+$/.test(t) ? rows.find((row) => row.no === Number(t))?.record : all.find((r) => r.id === t);
        if (hit) links.push(hit.id);
        else bad.push(t);
      }
      if (bad.length) return { status: 400, body: { ok: false, error: `--closes 里这些对不上看板：${bad.join("、")}（先 list 看号码）` } };
    }
    // 接力（2026-10-28 用户：交接单越堆越多）：写单的窗口手里领着交接单，新单顶掉它
    const by = typeof raw.by === "string" ? raw.by.trim() : "";
    const old = by && ctx.store.heldHandoff ? ctx.store.heldHandoff(by) : undefined;
    if (old?.checklist?.length) {
      return { status: 400, body: { ok: false, error: `你领着的「${old.text.slice(0, 30)}」有打勾清单，它本身就是交接单，不用另写新单：看板 log ${old.id} --by ${by} --text "停在哪、下一步"，再 看板 release ${old.id} --by ${by}` } };
    }
    // 同一件事别写第二张（2026-11-03 用户：43/45/46 三张都是同一件事）：跟已有交接单像就拦下，指给 AI 往旧单上记
    if (raw.force !== true) {
      const rows = indexBoard(all, ctx.store.boardNames?.().agents ?? []).flatMap((g) => g.rows);
      const alike = similarHandoffs(text, all.filter((r) => r.id !== old?.id)).slice(0, 3);
      if (alike.length) {
        const say = alike.map(({ record: r }) => {
          const no = rows.find((row) => row.record.id === r.id)?.no;
          return `第 ${no ?? "?"} 条「${r.text.replace(/\s+/g, " ").slice(0, 50)}」（id ${r.id}${r.claimedBy ? `，${r.claimedBy} 领着` : ""}${r.hold ? "，挂起中" : ""}）`;
        }).join("；");
        const first = alike[0].record;
        return { status: 409, body: { ok: false, error: `看板上已经有像同一件事的交接单：${say}。是同一件事 → 别写新单，接那张往上记：看板 next ${first.id} --by <你的窗口名>，再 看板 log ${first.id} --by <你的窗口名> --text "新情况"；确认是另一件事 → 原命令末尾加 --new 再写` } };
      }
    }
    const record = ctx.store.add({
      text,
      url: null,
      assignee: raw.assignee ? String(raw.assignee) : null,
      dedupeKey: null,
      kind: "handoff",
      detail: raw.detail ? String(raw.detail) : null,
      forSystem: typeof raw.forSystem === "string" && raw.forSystem.trim() ? raw.forSystem.trim() : null,
      links,
    });
    if (old && ctx.store.supersede) ctx.store.supersede(old.id, record.id);
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
    return { status: 200, body: { ok: true, id: record.id, kind: record.kind, replaced: old ? old.text.slice(0, 40) : null, links: links.length } };
  }
  // 派活单（设定23）：强模型一次写 1～3 张，同一个批号；用户点其中一张的「一键启动」就一起开。
  if (method === "POST" && path === "/paihuo") {
    if (!ctx.store.addDispatchBatch) return { status: 501, body: { ok: false, error: "看板还没接上派活单（重开桌宠试试）" } };
    const raw = (body ?? {}) as { cards?: unknown };
    const cards = Array.isArray(raw.cards) ? raw.cards : [];
    try {
      const made = ctx.store.addDispatchBatch(cards.map((c) => {
        const card = (c ?? {}) as Record<string, unknown>;
        return { text: String(card.text ?? ""), detail: card.detail ? String(card.detail) : null, assignee: String(card.assignee ?? "") };
      }));
      try {
        ctx.onChanged?.();
      } catch {
        /* 刷新失败无所谓 */
      }
      return { status: 200, body: { ok: true, batchId: made[0]?.batchId ?? null, items: made.map((r) => ({ id: r.id, assignee: r.assignee })) } };
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
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
  // 按号码读（2026-10-13）：brief＝只列号码和标题；show＝只吐点名那几条的全文。文字在这边排好，CLI 原样打印。
  if (method === "GET" && path === "/view") {
    if (!ctx.store.boardNames) return { status: 501, body: { ok: false, error: "看板还没接上按号码读（重开桌宠试试）" } };
    const query = new URL(urlPath, "http://localhost").searchParams;
    const { agents, ...names } = ctx.store.boardNames();
    const groups = indexBoard(ctx.store.list(), agents);
    try {
      if (query.get("mode") === "show") {
        const spec = parseShowSpec([query.get("spec") ?? ""]);
        return { status: 200, body: { ok: true, text: formatShow(groups, names, query.get("group") ?? "", spec, (t) => imagesForAgent(t)) } };
      }
      return { status: 200, body: { ok: true, text: formatBrief(groups, names, query.get("group") || undefined) } };
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
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
  if (method === "POST" && (path === "/next" || path === "/done" || path === "/release" || path === "/report" || path === "/log")) {
    return handleClaimRequest(path, (body ?? {}) as Record<string, unknown>, ctx);
  }
  if (method === "POST" && (path === "/checklist" || path === "/tick")) {
    return handleChecklistRequest(path, (body ?? {}) as Record<string, unknown>, ctx);
  }
  if (method === "POST" && (path === "/hold" || path === "/unhold")) {
    return handleHoldRequest(path, (body ?? {}) as Record<string, unknown>, ctx);
  }
  return { status: 404, body: { ok: false, error: "未知端点（POST /add | /handoff | /paihuo | /launch | /remove | /next | /done | /release | /report | /log | /checklist | /tick | /hold | /unhold | GET /list | /view）" } };
}

/** 命令行 launch（2026-10-16）：开窗要等一个个贴完，是异步的，单独一个口子；token 照样查。 */
export async function handleCliLaunch(body: unknown, authHeader: string | undefined, ctx: CliRequestContext): Promise<CliReply> {
  if (authHeader !== `Bearer ${ctx.token}`) return { status: 403, body: { ok: false, error: "token 不对（CLI 会自动读 cli-port.json，别手拼）" } };
  if (!ctx.store.launchBatch) return { status: 501, body: { ok: false, error: "看板还没接上 launch（看板里按 Ctrl+R 换新版）" } };
  const raw = (body ?? {}) as Record<string, unknown>;
  const id = String(raw.id ?? "").trim();
  if (!id) return { status: 400, body: { ok: false, error: "缺条目 id" } };
  try {
    const res = await ctx.store.launchBatch(id, Boolean(raw.coding), raw.model ? String(raw.model) : null);
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
    return { status: 200, body: { ok: true, ...res } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

/** launch 的结果说成一句给调度看的话（跟看板弹的那句同一个意思）。 */
export function formatLaunchResult(res: {
  launched: { name: string; label: string }[];
  conflicts: { a: string; b: string; files: string[] }[];
  missing: string[];
  skipped: { name: string; reason: string }[];
  model: string | null;
}): string {
  if (res.conflicts.length) {
    return `一个都没开：${res.conflicts.map((c) => `${c.a} 和 ${c.b} 都要动 ${c.files.join("、")}`).join("；")}。改单子的「只许动」或合成一张再开`;
  }
  const parts: string[] = [];
  if (res.model) parts.push(`Pi 换成 ${res.model}（思考档最高）`);
  if (res.launched.length) parts.push(`开了 ${res.launched.map((l) => `${l.label}（${l.name}）`).join("、")}，启动句已贴、没按回车：跟用户说每个窗口看一眼再按回车`);
  if (res.skipped.length) parts.push(`没开：${res.skipped.map((s) => `${s.name}（${s.reason}）`).join("、")}`);
  if (res.missing.length) parts.push(`${res.missing.join("、")} 没写「只许动」，没法查撞没撞文件`);
  return parts.join("。") || "这一批都有人领了，没开新窗口";
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
      const group = String(raw.group ?? "").trim();
      if (!target && !group) return { status: 400, body: { ok: false, error: "缺捆号或条目 id（或 --to 组名）" } };
      if (group && !store.claimInGroup) return { status: 500, body: { ok: false, error: "看板还不支持按组领（主进程未接线）" } };
      const template = raw.coding ? store.template?.("coding") ?? null : null;
      if (raw.coding && !template) return { status: 400, body: { ok: false, error: "要求模板「带编程」找不到了（看板 ⚙ 设置里打开要求模板夹看看）" } };
      const got = group ? store.claimInGroup!(group, by) : store.claimNext(target, by);
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
          mode: store.mode?.() ?? "day",
          cooperation: Boolean(got.bundleId),
          bundleId: got.bundleId,
          coordinator: got.coordinator,
          itemFile: got.record ? safeItemFile(store, got.record.id) : null,
          originalFile: got.record?.checklist?.length ? safeOriginalFile(store, got.record.id) : null,
          lastProgress: got.record ? lastProgress(got.record) : null,
        },
      };
    }
    const id = String(raw.id ?? "").trim();
    if (!id) return { status: 400, body: { ok: false, error: "缺条目 id" } };
    if (path === "/log") {
      if (!store.appendProgress) return { status: 500, body: { ok: false, error: "看板还不支持 log（看板里点「升级」换新版）" } };
      store.appendProgress(id, by, String(raw.text ?? ""));
      changed();
      return { status: 200, body: { ok: true } };
    }
    if (path === "/report") {
      if (!store.report) return { status: 500, body: { ok: false, error: "看板还不支持 report（主进程未接线）" } };
      const text = String(raw.text ?? "").trim();
      if (!text) return { status: 400, body: { ok: false, error: "报告是空的：用大白话写做了啥、改了哪些、怎么验的、还有啥没弄完" } };
      const record = store.report(id, by, text);
      const bundle = store.bundleInfo?.(record.bundleId);
      changed();
      return { status: 200, body: bundle ? { ok: true, cooperation: true, bundleId: bundle.id, coordinator: bundle.coordinator } : { ok: true } };
    }
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
    if (current.claimedBy && current.claimedBy !== by && current.claimedBy !== HANDED_OUT) {
      return { status: 400, body: { ok: false, error: `这条是 ${current.claimedBy} 领的，不是你的，放不回去` } };
    }
    store.release(id);
    changed();
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

/** 单号认法：屏幕上的号码按看板现在的数法换成那条，条目 id 原样认。 */
function resolveRecord(ctx: CliRequestContext, token: string): CliRecord | undefined {
  const all = ctx.store.list();
  if (/^\d+$/.test(token)) {
    return indexBoard(all, ctx.store.boardNames?.().agents ?? []).flatMap((g) => g.rows).find((row) => row.no === Number(token))?.record;
  }
  return all.find((r) => r.id === token);
}

/** 挂起两个口子（2026-11-03）：单号认法跟清单一样；store 抛的错原样回给 AI。 */
function handleHoldRequest(path: string, raw: Record<string, unknown>, ctx: CliRequestContext): CliReply {
  const store = ctx.store;
  if (!store.hold || !store.unhold) return { status: 500, body: { ok: false, error: "看板还不支持挂起（看板里点「升级」换新版）" } };
  const token = String(raw.id ?? "").trim();
  if (!token) return { status: 400, body: { ok: false, error: "缺单号（屏幕上的号码或条目 id）" } };
  const record = resolveRecord(ctx, token);
  if (!record) return { status: 404, body: { ok: false, error: `看板上找不到 ${token}（号码跟着看板变，先 list 看一眼）` } };
  try {
    const after = path === "/hold"
      ? store.hold(record.id, String(raw.by ?? "").trim(), String(raw.text ?? ""))
      : store.unhold(record.id);
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
    return { status: 200, body: { ok: true, id: after.id, title: after.text.slice(0, 40), held: Boolean(after.hold) } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

/** 打勾清单两个口子（2026-10-28）。store 抛的错（不是你领的、项号对不上）原样回给 AI，400。 */
function handleChecklistRequest(path: string, raw: Record<string, unknown>, ctx: CliRequestContext): CliReply {
  const store = ctx.store;
  const token = String(raw.id ?? "").trim();
  if (!token) return { status: 400, body: { ok: false, error: "缺单号（屏幕上的号码或条目 id）" } };
  const record = resolveRecord(ctx, token);
  if (!record) return { status: 404, body: { ok: false, error: `看板上找不到 ${token}（全勾完的单子会自动收掉；先 list 看号码）` } };
  const changed = () => {
    try {
      ctx.onChanged?.();
    } catch {
      /* 刷新失败无所谓 */
    }
  };
  try {
    if (path === "/checklist") {
      if (!store.setChecklist) return { status: 500, body: { ok: false, error: "看板还不支持打勾清单（看板里点「升级」换新版）" } };
      const by = String(raw.by ?? "").trim();
      if (!by) return { status: 400, body: { ok: false, error: "缺 --by 窗口名" } };
      const items = parseChecklist(String(raw.md ?? ""));
      const saved = store.setChecklist(record.id, items, by);
      changed();
      const { done, total } = checklistProgress(saved.checklist);
      return { status: 200, body: { ok: true, id: saved.id, done, total, items: saved.checklist?.length ?? 0, by, next: firstPending(saved.checklist) } };
    }
    if (!store.tick) return { status: 500, body: { ok: false, error: "看板还不支持打勾（看板里点「升级」换新版）" } };
    const nos = (Array.isArray(raw.nos) ? raw.nos : [raw.no]).map((x) => String(x ?? "").trim()).filter(Boolean);
    if (!nos.length) return { status: 400, body: { ok: false, error: "缺项号：勾 <单号> 2.1" } };
    const by = typeof raw.by === "string" && raw.by.trim() ? raw.by.trim() : null;
    const flips: { no: string; on: boolean }[] = [];
    let last: ReturnType<NonNullable<CliStoreAdapter["tick"]>> | null = null;
    for (const no of nos) {
      last = store.tick(record.id, no, by);
      flips.push({ no, on: Boolean(last.record.checklist?.find((x) => x.no === no)?.done) });
      if (last.closed) break;
    }
    changed();
    return { status: 200, body: { ok: true, flips, done: last!.done, total: last!.total, closed: last!.closed, linksRemoved: last!.linksRemoved } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

/** 有清单的单子怎么干（2026-10-28 用户拍板）：领活和交清单回的都是这几行，规矩只写这一处。 */
function checklistRules(id: string, by: string, next: string): string[] {
  return [
    "—— 干活规矩（有清单的单子，所有 AI 都一样）——",
    `1. 照没勾的一项项干，干完一项马上勾：看板 勾 ${id} ${next}（勾错了再敲一次取消）。勾了就是记了进度，不用另外 log。`,
    "2. 中途改了主意（原来那项不走了、换了办法）＝那项的目的已达到，直接勾掉，不重写清单、不改原话。卡住的项（缺东西、要到另一套系统上干、问题还没解决）不勾，跳过它接着干别的，不停下来问。",
    "3. 能干的都干完了再汇报一次（全勾完的话单子已自动收掉、管着的条目一起删，不用 done）：照清单的两层结构列，每项前面标 ✅ 做完 / ⏸ 做到一半（写到哪一步）/ ⛔ 做不了（一句原因），末尾写建议下一步，等用户一起商量。这份就是收尾清单，不另写；中途不逐项汇报。",
    `4. 要换窗口、换人（上下文快满、额度快完、整张做不下去）：这张单子本身就是交接单，不另写新单。先记一句停在哪：看板 log ${id} --by ${by} --text "停在哪、下一步"，再放回去：看板 release ${id} --by ${by}`,
  ];
}

/** 第一个还没勾的项号（命令例子用它，别写成已经勾过的号）。 */
function firstPending(items: ChecklistItem[] | undefined): string {
  return items?.find((x) => !x.done && (x.no.includes(".") || !items.some((y) => y.no.startsWith(`${x.no}.`))))?.no ?? "1";
}

/** 交完清单的回话：交了几项，接着怎么干。 */
export function formatChecklistSaved(data: { id: string; done: number; total: number; items: number; by: string; next: string }): string {
  return [`☑ 清单交进去了：${data.total} 件事、共 ${data.items} 项（${data.done}/${data.total}）。`, ...checklistRules(data.id, data.by, data.next)].join("\n");
}

/** 打勾的回话：一行说清勾了啥、进度几；全勾完说一声收掉了。 */
export function formatTickResult(data: { flips: { no: string; on: boolean }[]; done: number; total: number; closed: boolean; linksRemoved: number }): string {
  if (data.closed) {
    return `✅ 全勾完了（${data.total}/${data.total}），单子已自动收掉${data.linksRemoved ? `，管着的 ${data.linksRemoved} 条一起删了` : ""}，记进了做完记录。照领活规矩第 3 条汇报一次，不用 done。`;
  }
  const what = data.flips.map((f) => `${f.on ? "✔" : "○"} ${f.no}${f.on ? "" : " 取消勾"}`).join("  ");
  return `${what}（${data.done}/${data.total}）`;
}

function safeItemFile(store: CliStoreAdapter, id: string): string | null {
  try {
    return store.itemFile?.(id) ?? null;
  } catch {
    return null;
  }
}

function safeOriginalFile(store: CliStoreAdapter, id: string): string | null {
  try {
    return store.originalFile?.(id) ?? null;
  } catch {
    return null;
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
      req.on("end", async () => {
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
          const isLaunch = req.method === "POST" && (req.url ?? "").split("?")[0] === "/launch";
          const reply = isLaunch
            ? await handleCliLaunch(body, req.headers.authorization, ctx)
            : handleCliRequest(req.method ?? "GET", req.url ?? "/", body, req.headers.authorization, ctx);
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
