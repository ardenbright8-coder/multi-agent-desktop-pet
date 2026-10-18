// vivo 截图复制：往剪贴板里塞的那几样东西怎么拼。全是纯函数，不碰系统，测试 testkit/tests/vivo-clip-format.test.ts 盯着。

import { extname, join, resolve } from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);

/** vivo 复制、拖图时先把图存到这里（vivo 程序里写死的，设置改不了）。 */
export function vivoClipDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VIVO截图夹) return env.VIVO截图夹;
  return join(env.APPDATA || "", "vivoClipdata");
}

/**
 * 剪贴板里那几个文件是不是「vivo 刚复制的一张截图」：只认恰好一个文件、在 vivo 那个夹里、是图片。
 * 在文件夹里复制普通文件、一次复制好几个，都不算，原样不碰。
 */
export function pickVivoImage(paths: readonly string[], directory: string): string | null {
  if (paths.length !== 1) return null;
  const file = paths[0];
  const folder = resolve(directory).toLowerCase();
  const full = resolve(file).toLowerCase();
  if (!full.startsWith(`${folder}\\`) && !full.startsWith(`${folder}/`)) return null;
  return IMAGE_EXTENSIONS.has(extname(full)) ? file : null;
}

/** 以 0 结尾的 UTF-16 字符串（Windows 剪贴板的文字格式就要这个）。 */
export function utf16z(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

/**
 * 「复制了这些文件」那个格式（CF_HDROP）的内容：20 字节的头（DROPFILES）+ 一串路径，每个以 0 结尾，最后再多一个 0。
 * 头里只填两项：路径从第 20 字节开始；路径是 UTF-16（fWide=1）。
 */
export function buildDropFiles(paths: readonly string[]): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);
  header.writeUInt32LE(1, 16);
  const list = Buffer.from(`${paths.map((path) => `${path}\0`).join("")}\0`, "utf16le");
  return Buffer.concat([header, list]);
}

/**
 * 「一张图」那个格式（CF_DIB）的内容：40 字节的头 + 24 位色、从下往上一行一行排的像素，每行凑够 4 的倍数字节。
 * 传进来的是 Electron 给的像素（每点 4 字节，蓝绿红透明，从上往下）。透明那一位扔掉——截图本来就不透明，
 * 用 24 位是因为老程序对 32 位图的透明位各认各的，有的会贴出一张全透明的图。
 */
export function bgraToDib24(bgra: Buffer, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0 || bgra.length < width * height * 4) throw new Error(`像素数据不够：${width}x${height} 要 ${width * height * 4} 字节，只有 ${bgra.length}`);
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(24, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(rowBytes * height, 20);
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const from = y * width * 4;
    const to = (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x += 1) {
      pixels[to + x * 3] = bgra[from + x * 4];
      pixels[to + x * 3 + 1] = bgra[from + x * 4 + 1];
      pixels[to + x * 3 + 2] = bgra[from + x * 4 + 2];
    }
  }
  return Buffer.concat([header, pixels]);
}
