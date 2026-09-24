// 看板贴图的磁盘边界：只接图片字节，解码后存 PNG；读图只认本夹文件名，不接受路径。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ipcMain, nativeImage, type WebContents } from "electron";
import { attachmentsRoot } from "../shared/paths";

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
}
