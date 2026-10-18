// vivo 截图复制（2026-10-18 用户拍板）：在 vivo 办公套件里点「复制」后，vivo 往剪贴板里放的是「复制了一个文件」，
// 网页认、命令窗口和很多程序不认。这块盯着剪贴板，一看到是 vivo 那个夹里的一张图，就原样留着文件，再补两样：
// 一张真正的图（微信、Word、Claude Code / Pi 按 Alt+V 认）、一行图片位置（命令窗口里 Ctrl+V 贴出来就是它）。
//
// 🚨 隔离铁律：只借桌宠程序当入口，跟桌宠、看板、Ctrl+Q 零共享状态，只认 shared。坏了只记日志，不许连坐别人。
// 对外只露出 initVivoClip / closeVivoClip / vivoClipStatus，app.ts 装配时调。
//
// - 不碰：在文件夹里复制普通文件、一次复制好几个、复制文字——只认「恰好一个文件、在 vivo 那个夹里、是图片」
// - 防自己转自己：补完时顺手放一个只有本块认识的记号格式，下次看到有记号就跳过
// - vivo 复制是两步：先清空，约 1 秒后才放文件。轮询看到哪步算哪步，不用等

import { nativeImage } from "electron";
import { createLogger } from "../shared/log";
import { bgraToDib24, buildDropFiles, pickVivoImage, utf16z, vivoClipDirectory } from "./clip-format";
import { CF_DIB, CF_HDROP, CF_UNICODETEXT, loadVivoWin32, type VivoWin32 } from "./win32";

const log = createLogger("vivo");

const POLL_MS = 300;
/** 命令窗口里 Ctrl+V 只能贴字，所以补一行图片位置。网页要是因此多贴出一行字，把这里改 false。 */
const PUT_PATH_TEXT = true;

export interface VivoClipStatus {
  state: "在跑" | "没启用" | "出错";
  converted: number;
  lastFile: string;
  lastAt: number;
}

let win32: VivoWin32 | null = null;
let timer: NodeJS.Timeout | null = null;
let lastSequence = -1;
let markerFormat = 0;
let pngFormat = 0;
const status: VivoClipStatus = { state: "没启用", converted: 0, lastFile: "", lastAt: 0 };

export function initVivoClip(): void {
  try {
    win32 = loadVivoWin32();
    if (!win32) {
      status.state = "出错";
      return;
    }
    markerFormat = win32.register("AgentPetVivoClip");
    pngFormat = win32.register("PNG");
    lastSequence = win32.sequence();
    timer = setInterval(tick, POLL_MS);
    timer.unref();
    status.state = "在跑";
    log.记(`vivo 截图复制就绪，盯着 ${vivoClipDirectory()}`, "init");
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

function tick(): void {
  if (!win32) return;
  try {
    const sequence = win32.sequence();
    if (sequence === lastSequence) return;
    if (!win32.has(CF_HDROP) || win32.has(markerFormat)) {
      lastSequence = sequence;
      return;
    }
    const files = win32.readFiles();
    if (files === null) return; // 别人正占着剪贴板，下一轮再看
    lastSequence = sequence;
    const picked = pickVivoImage(files, vivoClipDirectory());
    if (picked) convert(picked);
  } catch (error) {
    log.出事("看剪贴板出错", error, "tick");
  }
}

function convert(file: string): void {
  if (!win32) return;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    log.记(`读不出这张图，原样不动：${file}`, "convert");
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
    log.出事(`往剪贴板补图失败：${file}`, undefined, "convert");
    return;
  }
  lastSequence = win32.sequence();
  status.converted += 1;
  status.lastFile = file;
  status.lastAt = Date.now();
  log.记(`补好了 ${width}x${height}：${file}`, "convert");
}
