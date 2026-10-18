// vivo 截图复制：中转夹里的文件怎么起名、留几张，往剪贴板里塞的那几样东西怎么拼。全是纯函数，不碰系统，
// 测试 testkit/tests/vivo-clip-format.test.ts 盯着。

/** 剪贴板里「一张光秃秃的图」另存到这个夹（vivo 接收夹旁边，不占 C 盘）。环境变量能改，测试用。 */
export function transitDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.VIVO中转夹 || "D:\\Downloads\\vivo办公套件\\截图中转";
}

/** 中转夹只留最新这么多张，多的从最旧的删（只删本块存的、名字对得上的）。 */
export const KEEP_FILES = 100;
const NAME_PATTERN = /^截图_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?\.jpg$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** PixPin 那种起法：截图_2026-10-18_06-17-50.jpg。同一秒第二张加 _2。 */
export function transitFileName(date: Date, sameSecondIndex = 0): string {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `截图_${stamp}${sameSecondIndex ? `_${sameSecondIndex + 1}` : ""}.jpg`;
}

/** 该删哪些：只认本块起的名字，按名字（也就是时间）排，留最新 keep 张。 */
export function filesToPrune(names: readonly string[], keep = KEEP_FILES): string[] {
  const ours = names.filter((name) => NAME_PATTERN.test(name)).sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/**
 * 剪贴板里是不是「一张光秃秃的图」：有图，没有文件、没有字、没有网页片段、没有本块的记号。
 * vivo 截图弹窗点「复制」就是这样（2026-10-18 实测：只有 PNG 和位图，连主人窗口都是空的）。
 * PixPin（带文件）、浏览器里复制图片（带网页片段）、复制文字都不算，原样不碰。
 */
export function isBareImage(has: { image: boolean; files: boolean; text: boolean; html: boolean; marker: boolean }): boolean {
  return has.image && !has.files && !has.text && !has.html && !has.marker;
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
