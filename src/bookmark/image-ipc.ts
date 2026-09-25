// 看板贴图的磁盘边界：只接图片字节，解码后存 PNG；读图只认本夹文件名，不接受路径。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ipcMain, nativeImage, type WebContents } from "electron";
import { writeJsonAtomic } from "../shared/atomic-file";
import { attachmentsRoot } from "../shared/paths";
import { MARKABLE_IMAGE, markedFileName, marksFileName, readImageMarks, sanitizeMarks, sanitizeSummary } from "./inline-images";

const MAX_BYTES = 20 * 1024 * 1024;
export function registerBookmarkImageIpc(allowed: (sender: WebContents) => boolean): void {
  ipcMain.handle("bookmark:image:save", (event, raw: unknown) => {
    if (!allowed(event.sender)) throw new Error("只允许看板添加图片");
    if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES) throw new Error("请选择 20 MB 以内的图片");
    const picture = nativeImage.createFromBuffer(Buffer.from(raw));
    const size = picture.getSize();
    if (picture.isEmpty() || size.width * size.height > 32_000_000) throw new Error("图片无法读取或尺寸过大");
    const png = picture.toPNG();
    if (png.length > MAX_BYTES) throw new Error("图片解码后过大，请缩小后再贴");
    const dir = attachmentsRoot();
    mkdirSync(dir, { recursive: true });
    const name = `image-${randomUUID()}.png`;
    writeFileSync(join(dir, name), png, { flag: "wx" });
    return name;
  });
  ipcMain.handle("bookmark:image:read", (event, name: unknown) => {
    if (!allowed(event.sender)) throw new Error("只允许看板读取图片");
    if (typeof name !== "string" || name !== basename(name) || /[\\/:]/.test(name) || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) throw new Error("图片文件名无效");
    const path = join(attachmentsRoot(), name);
    if (statSync(path).size > MAX_BYTES) throw new Error("图片过大");
    const picture = nativeImage.createFromBuffer(readFileSync(path));
    if (picture.isEmpty()) throw new Error("图片无法读取");
    return picture.toDataURL();
  });
  // 图片标注（设定16第三版）：标注单独存，原图不动；带编号的那张只给 AI 看。
  ipcMain.handle("bookmark:image:marks:get", (event, name: unknown) => {
    if (!allowed(event.sender)) throw new Error("只允许看板读取标注");
    if (typeof name !== "string" || !MARKABLE_IMAGE.test(name)) throw new Error("图片文件名无效");
    const { marks, summary } = readImageMarks(name);
    return { marks, summary };
  });
  ipcMain.handle("bookmark:image:marks:set", (event, payload: unknown) => {
    if (!allowed(event.sender)) throw new Error("只允许看板保存标注");
    const { name, marks: raw, summary: rawSummary, marked } = (payload ?? {}) as { name?: unknown; marks?: unknown; summary?: unknown; marked?: unknown };
    if (typeof name !== "string" || !MARKABLE_IMAGE.test(name)) throw new Error("图片文件名无效");
    const dir = attachmentsRoot();
    const marksPath = join(dir, marksFileName(name));
    const markedPath = join(dir, markedFileName(name));
    const marks = sanitizeMarks(raw);
    const summary = sanitizeSummary(rawSummary);
    if (!marks.length && !summary.trim()) {
      // 全删光了＝回到没标过：两个附属文件一起清掉，交给 AI 只给原图。
      rmSync(marksPath, { force: true });
      rmSync(markedPath, { force: true });
      return { marks, summary: "" };
    }
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(marksPath, { marks, summary });
    // 只写了整体说明、一个标注都没画：不要带编号的图，交给 AI 给原图＋说明。
    if (!marks.length) rmSync(markedPath, { force: true });
    else if (marked instanceof Uint8Array && marked.length && marked.length <= MAX_BYTES) {
      const picture = nativeImage.createFromBuffer(Buffer.from(marked));
      if (!picture.isEmpty()) writeFileSync(markedPath, picture.toPNG());
    }
    return { marks, summary };
  });
}
