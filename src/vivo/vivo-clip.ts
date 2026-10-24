// vivo 截图复制（2026-10-18 用户拍板）：vivo 办公套件截图弹窗点「复制」，放进剪贴板的是「一张光秃秃的图」
// （它的代码就是 Electron 的 clipboard.writeImage，只有 PNG 和位图）。网页认，Claude Code 在 Windows 上读剪贴板图经常失灵，
// 命令窗口 Ctrl+V 只能贴字。社区的办法（也是这块的做法）：把图另存成真文件，再把「这个文件」和「文件位置」一起放进剪贴板——
// Claude Code、Pi 拿到图片文件的位置会自己打开，比读剪贴板稳得多。
//
// 一看到剪贴板里是光秃秃的一张图，就：存成 jpg 到中转夹（D 盘，只留最新 100 张）→ 清空重放：
// 这个文件 + 一张图（DIB、PNG）+ 文件位置那行字 + 本块的记号。网页、微信照样贴图，命令窗口 Ctrl+V 贴出位置。
//
// 🚨 隔离铁律：只借桌宠程序当入口，跟桌宠、看板、Ctrl+Q 零共享状态，只认 shared。坏了只记日志，不许连坐别人。
// 对外只露出 initVivoClip / closeVivoClip / vivoClipStatus，app.ts 装配时调。
//
// - 不碰：带文件的（PixPin 截图）、带网页片段的（浏览器里复制图片）、带字的、本块自己放的（有记号）
// - 认不出是谁放的：vivo 写剪贴板时主人窗口是空的，所以按「光秃秃一张图」认。系统截图工具这类同样光秃秃的图也会顺手补上

import { mkdirSync, readdirSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Notification, app, clipboard } from "electron";
import { createLogger } from "../shared/log";
import { bgraToDib24, buildDropFiles, filesToPrune, isBareImage, transitDirectory, transitFileName, utf16z } from "./clip-format";
import { checkDragPatch, patchCmd, type DragPatchState } from "./drag-patch";
import { CF_DIB, CF_HDROP, CF_UNICODETEXT, loadVivoWin32, type VivoWin32 } from "./win32";

const log = createLogger("vivo");

const POLL_MS = 300;
/** 卡住自恢复（2026-10-24 加）：看门狗多久看一次；轮询多久没跑算停了；光秃秃的图没补上隔多久重试、最多几次；连着几次放不进剪贴板就重建 */
const WATCHDOG_MS = 5_000;
const STALL_MS = 5_000;
const RETRY_MS = 2_000;
const MAX_RETRY = 3;
const REBUILD_AFTER_FAILS = 3;
/** 命令窗口里 Ctrl+V 只能贴字，所以补一行文件位置。哪个程序因此多贴出一行字，把这里改 false。 */
const PUT_PATH_TEXT = true;
const JPEG_QUALITY = 92;

export interface VivoClipStatus {
  state: "在跑" | "没启用" | "出错";
  converted: number;
  lastFile: string;
  lastAt: number;
  /** vivo 拖图补丁（改 vivo 程序包，拖弹窗里的图交原图文件）还在不在，开机看一次 */
  dragPatch: DragPatchState;
}

let win32: VivoWin32 | null = null;
let timer: NodeJS.Timeout | null = null;
let lastSequence = -1;
let pendingSequence = -1;
let markerFormat = 0;
let pngFormat = 0;
let htmlFormat = 0;
let watchdog: NodeJS.Timeout | null = null;
let lastTickAt = 0;
/** 认出是光秃秃的图、但没补成的那次剪贴板（序号）和重试了几次。补成了或剪贴板换了就清掉 */
let missedSequence = -1;
let missedRetries = 0;
let missedAt = 0;
let writeFails = 0;
/** 同一句日志不刷屏：上一句和上一次写的时间 */
let lastNote = "";
let lastNoteAt = 0;
const status: VivoClipStatus = { state: "没启用", converted: 0, lastFile: "", lastAt: 0, dragPatch: "看不出来" };

export function initVivoClip(): void {
  watchDragPatch();
  try {
    if (!startPolling()) return;
    watchdog = setInterval(watch, WATCHDOG_MS);
    watchdog.unref();
    log.记(`vivo 截图复制就绪，图存到 ${transitDirectory()}`, "init");
  } catch (error) {
    status.state = "出错";
    log.出事("vivo 截图复制初始化失败（不影响别的板块）", error, "init");
  }
}

/** 开（或重开）剪贴板接口和 0.3 秒轮询。看门狗重建也走这里 */
function startPolling(): boolean {
  if (timer) clearInterval(timer);
  timer = null;
  win32 = loadVivoWin32();
  if (!win32) {
    status.state = "出错";
    return false;
  }
  markerFormat = win32.register("AgentPetVivoClip");
  pngFormat = win32.register("PNG");
  htmlFormat = win32.register("HTML Format");
  lastSequence = win32.sequence();
  pendingSequence = -1;
  lastTickAt = Date.now();
  writeFails = 0;
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  status.state = "在跑";
  return true;
}

/** 重建：关掉剪贴板主人小窗口，重新开接口和轮询。之后剪贴板里那张没补的图交给看门狗重试 */
function rebuild(why: string): void {
  log.记(`vivo 截图复制自己重建（${why}）`, "watchdog");
  try {
    win32?.dispose();
  } catch (error) {
    log.出事("重建时关旧的剪贴板小窗口出错（接着重建）", error, "watchdog");
  }
  win32 = null;
  const keep = missedSequence;
  if (!startPolling()) {
    log.出事("重建失败，vivo 截图复制停了（重开桌宠再试）", undefined, "watchdog");
    return;
  }
  // 重建前就在剪贴板里那张图：序号没变，轮询不会再看它，交给看门狗重试
  if (keep >= 0) missedSequence = keep;
}

/**
 * 看门狗（2026-10-24 加）：那天 2:45–3:24 一张没补，重开桌宠才好，日志里什么都没留。现在每 5 秒看三样：
 * 轮询还在不在跑、剪贴板主人小窗口还在不在、剪贴板里有没有光秃秃的图一直没补上（有就重试，重试不行就重建）。
 */
function watch(): void {
  try {
    const now = Date.now();
    if (!win32) {
      rebuild("剪贴板接口没了");
      return;
    }
    if (now - lastTickAt > STALL_MS) {
      rebuild(`轮询 ${Math.round((now - lastTickAt) / 1000)} 秒没跑`);
      return;
    }
    if (!win32.alive()) {
      rebuild("剪贴板主人小窗口没了");
      return;
    }
    if (missedSequence < 0) return;
    if (win32.sequence() !== missedSequence) {
      missedSequence = -1;
      return;
    }
    if (now - missedAt < RETRY_MS) return;
    if (missedRetries >= MAX_RETRY) {
      note(`剪贴板里那张光秃秃的图重试 ${MAX_RETRY} 次都没补上，不再试（再点一次复制会重新来）`);
      missedSequence = -1;
      return;
    }
    missedRetries += 1;
    missedAt = now;
    log.记(`剪贴板里有光秃秃的图没补上，第 ${missedRetries} 次重试`, "watchdog");
    if (!readBare()) {
      missedSequence = -1;
      return;
    }
    convert(missedSequence);
  } catch (error) {
    note("看门狗出错", error);
  }
}

export function closeVivoClip(): void {
  try {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    if (timer) clearInterval(timer);
    timer = null;
    win32?.dispose();
  } catch (error) {
    log.出事("vivo 截图复制退出清理出错", error, "close");
  }
}

export function vivoClipStatus(): VivoClipStatus {
  return { ...status };
}

function watchDragPatch(): void {
  try {
    status.dragPatch = checkDragPatch();
    log.记(`vivo 拖图补丁：${status.dragPatch}`, "patch");
    if (!Notification.isSupported()) return;
    if (status.dragPatch === "被升级盖掉了") {
      new Notification({
        // 两套系统各装各的 vivo：这套可能从没装过，也可能是升级盖掉了
        title: "这套系统的 vivo 没有拖图补丁（没装过或被升级盖掉了）",
        body: `拖 vivo 截图又只能拖出链接了。双击 ${patchCmd(app.getAppPath())} 重新装上（会弹一次管理员确认）`,
      }).show();
    } else if (status.dragPatch === "装的是旧版补丁") {
      // 补丁出了新版（2026-10-24 v2：点图复制、弹窗回右下角），两套系统各自要重装一次
      new Notification({
        title: "vivo 拖图补丁有新版了",
        body: `点图就复制、弹窗回到右下角。双击 ${patchCmd(app.getAppPath())} 换上（会关一下 vivo、弹一次管理员确认）`,
      }).show();
    }
  } catch (error) {
    status.dragPatch = "看不出来";
    log.出事("看 vivo 拖图补丁出错（不影响复制）", error, "patch");
  }
}

function tick(): void {
  if (!win32) return;
  lastTickAt = Date.now();
  try {
    const sequence = win32.sequence();
    if (sequence === lastSequence) return;
    // 等剪贴板稳一下再动：vivo 一次复制会连写两回（实测隔 0.1 秒），夹在中间动手会被它第二回盖掉、再转一遍
    if (sequence !== pendingSequence) {
      pendingSequence = sequence;
      return;
    }
    lastSequence = sequence;
    if (missedSequence >= 0 && missedSequence !== sequence) missedSequence = -1;
    if (readBare()) convert(sequence);
  } catch (error) {
    note("看剪贴板出错", error);
  }
}

/** 剪贴板里是不是光秃秃一张图。有图但不补的，记一句为什么跳过 */
function readBare(): boolean {
  if (!win32) return false;
  const seen = {
    image: win32.has(CF_DIB) || win32.has(pngFormat),
    files: win32.has(CF_HDROP),
    text: win32.has(CF_UNICODETEXT),
    html: win32.has(htmlFormat),
    marker: win32.has(markerFormat),
  };
  if (isBareImage(seen)) return true;
  if (seen.image && !seen.marker) {
    const why = [seen.files && "带文件（PixPin 这类）", seen.html && "带网页片段", seen.text && "带字"].filter(Boolean).join("、");
    note(`剪贴板有图但不补：${why}`);
  }
  return false;
}

/** 补一次。没补成的记下序号交给看门狗重试 */
function convert(sequence: number): void {
  if (!win32) return;
  const missed = (why: string): void => {
    if (missedSequence !== sequence) {
      missedSequence = sequence;
      missedRetries = 0;
    }
    missedAt = Date.now();
    log.记(`这张没补上：${why}（等会儿自动重试）`, "convert");
  };
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    missed("剪贴板说有图，但读出来是空的");
    return;
  }
  let file: string;
  try {
    file = saveToTransit(image.toJPEG(JPEG_QUALITY));
  } catch (error) {
    log.出事("存中转图出错", error, "convert");
    missed("存不进中转夹");
    return;
  }
  const { width, height } = image.getSize();
  const items = [
    { format: CF_HDROP, data: buildDropFiles([file]) },
    { format: CF_DIB, data: bgraToDib24(image.toBitmap(), width, height) },
    { format: pngFormat, data: image.toPNG() },
    ...(PUT_PATH_TEXT ? [{ format: CF_UNICODETEXT, data: utf16z(file) }] : []),
    { format: markerFormat, data: Buffer.from([1]) },
  ];
  if (!win32.write(items)) {
    writeFails += 1;
    log.出事(`往剪贴板补文件失败（图已存好，连着第 ${writeFails} 次）：${file}`, undefined, "convert");
    missed("放不进剪贴板");
    if (writeFails >= REBUILD_AFTER_FAILS) rebuild(`连着 ${writeFails} 次放不进剪贴板`);
    return;
  }
  writeFails = 0;
  missedSequence = -1;
  lastSequence = win32.sequence();
  pendingSequence = lastSequence;
  status.converted += 1;
  status.lastFile = file;
  status.lastAt = Date.now();
  log.记(`补好了 ${width}x${height}：${file}`, "convert");
  prune();
}

/** 写日志，同一句 1 分钟内只写一次（轮询 0.3 秒一回，出错不刷屏） */
function note(text: string, error?: unknown): void {
  const now = Date.now();
  if (text === lastNote && now - lastNoteAt < 60_000) return;
  lastNote = text;
  lastNoteAt = now;
  if (error === undefined) log.记(text, "tick");
  else log.出事(text, error, "tick");
}

function saveToTransit(jpeg: Buffer): string {
  const folder = transitDirectory();
  mkdirSync(folder, { recursive: true });
  const now = new Date();
  let index = 0;
  let file = join(folder, transitFileName(now));
  while (existsSync(file)) {
    index += 1;
    file = join(folder, transitFileName(now, index));
  }
  writeFileSync(file, jpeg);
  return file;
}

function prune(): void {
  try {
    const folder = transitDirectory();
    for (const name of filesToPrune(readdirSync(folder))) unlinkSync(join(folder, name));
  } catch (error) {
    log.出事("清中转夹旧图出错（不影响复制）", error, "prune");
  }
}
