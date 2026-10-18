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
import { Notification, clipboard } from "electron";
import { createLogger } from "../shared/log";
import { bgraToDib24, buildDropFiles, filesToPrune, isBareImage, transitDirectory, transitFileName, utf16z } from "./clip-format";
import { PATCH_DIR, checkDragPatch, type DragPatchState } from "./drag-patch";
import { CF_DIB, CF_HDROP, CF_UNICODETEXT, loadVivoWin32, type VivoWin32 } from "./win32";

const log = createLogger("vivo");

const POLL_MS = 300;
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
const status: VivoClipStatus = { state: "没启用", converted: 0, lastFile: "", lastAt: 0, dragPatch: "看不出来" };

export function initVivoClip(): void {
  watchDragPatch();
  try {
    win32 = loadVivoWin32();
    if (!win32) {
      status.state = "出错";
      return;
    }
    markerFormat = win32.register("AgentPetVivoClip");
    pngFormat = win32.register("PNG");
    htmlFormat = win32.register("HTML Format");
    lastSequence = win32.sequence();
    timer = setInterval(tick, POLL_MS);
    timer.unref();
    status.state = "在跑";
    log.记(`vivo 截图复制就绪，图存到 ${transitDirectory()}`, "init");
  } catch (error) {
    status.state = "出错";
    log.出事("vivo 截图复制初始化失败（不影响别的板块）", error, "init");
  }
}

export function closeVivoClip(): void {
  try {
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
    if (status.dragPatch !== "被升级盖掉了" || !Notification.isSupported()) return;
    new Notification({
      title: "vivo 拖图补丁被升级盖掉了",
      body: `拖 vivo 截图又只能拖出链接了。双击 ${PATCH_DIR}\\双击装补丁.cmd 重新装上（会弹一次管理员确认）`,
    }).show();
  } catch (error) {
    status.dragPatch = "看不出来";
    log.出事("看 vivo 拖图补丁出错（不影响复制）", error, "patch");
  }
}

function tick(): void {
  if (!win32) return;
  try {
    const sequence = win32.sequence();
    if (sequence === lastSequence) return;
    // 等剪贴板稳一下再动：vivo 一次复制会连写两回（实测隔 0.1 秒），夹在中间动手会被它第二回盖掉、再转一遍
    if (sequence !== pendingSequence) {
      pendingSequence = sequence;
      return;
    }
    lastSequence = sequence;
    const bare = isBareImage({
      image: win32.has(CF_DIB) || win32.has(pngFormat),
      files: win32.has(CF_HDROP),
      text: win32.has(CF_UNICODETEXT),
      html: win32.has(htmlFormat),
      marker: win32.has(markerFormat),
    });
    if (bare) convert();
  } catch (error) {
    log.出事("看剪贴板出错", error, "tick");
  }
}

function convert(): void {
  if (!win32) return;
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    log.记("剪贴板说有图，但读出来是空的，原样不动", "convert");
    return;
  }
  const file = saveToTransit(image.toJPEG(JPEG_QUALITY));
  const { width, height } = image.getSize();
  const items = [
    { format: CF_HDROP, data: buildDropFiles([file]) },
    { format: CF_DIB, data: bgraToDib24(image.toBitmap(), width, height) },
    { format: pngFormat, data: image.toPNG() },
    ...(PUT_PATH_TEXT ? [{ format: CF_UNICODETEXT, data: utf16z(file) }] : []),
    { format: markerFormat, data: Buffer.from([1]) },
  ];
  if (!win32.write(items)) {
    log.出事(`往剪贴板补文件失败（图已存好）：${file}`, undefined, "convert");
    return;
  }
  lastSequence = win32.sequence();
  pendingSequence = lastSequence;
  status.converted += 1;
  status.lastFile = file;
  status.lastAt = Date.now();
  log.记(`补好了 ${width}x${height}：${file}`, "convert");
  prune();
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
