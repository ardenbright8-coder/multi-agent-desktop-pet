// vivo 截图复制单测：认不认「光秃秃一张图」、中转夹起名和留几张、拼「复制的文件」和「一张图」两种格式（往系统剪贴板放在 vivo/win32，这里不碰）。

import assert from "node:assert/strict";
import test from "node:test";
import { bgraToDib24, buildDropFiles, filesToPrune, isBareImage, transitDirectory, transitFileName, utf16z } from "../../vivo/clip-format";

test("transitDirectory：默认 D 盘 vivo 接收夹旁边，环境变量能改", () => {
  assert.equal(transitDirectory({}), "D:\\Downloads\\vivo办公套件\\截图中转");
  assert.equal(transitDirectory({ VIVO中转夹: "E:\\x" }), "E:\\x");
});

test("isBareImage：只认有图、没文件没字没网页片段没记号的", () => {
  const base = { image: true, files: false, text: false, html: false, marker: false };
  assert.equal(isBareImage(base), true, "vivo 复制：只有图");
  assert.equal(isBareImage({ ...base, files: true }), false, "PixPin 带文件，不碰");
  assert.equal(isBareImage({ ...base, html: true }), false, "浏览器复制图片带网页片段，不碰");
  assert.equal(isBareImage({ ...base, text: true }), false);
  assert.equal(isBareImage({ ...base, marker: true }), false, "自己放的不再转");
  assert.equal(isBareImage({ ...base, image: false }), false);
});

test("transitFileName：PixPin 那种起法，同一秒第二张加 _2", () => {
  const date = new Date(2026, 9, 18, 6, 7, 5);
  assert.equal(transitFileName(date), "截图_2026-10-18_06-07-05.jpg");
  assert.equal(transitFileName(date, 1), "截图_2026-10-18_06-07-05_2.jpg");
});

test("filesToPrune：只删本块起名的、最旧的，留最新 keep 张", () => {
  const names = ["截图_2026-10-18_06-00-03.jpg", "截图_2026-10-18_06-00-01.jpg", "截图_2026-10-18_06-00-02.jpg", "别人的.jpg", "截图_乱起的.jpg"];
  assert.deepEqual(filesToPrune(names, 2), ["截图_2026-10-18_06-00-01.jpg"]);
  assert.deepEqual(filesToPrune(names, 5), []);
});

test("utf16z：UTF-16 加一个 0 结尾", () => {
  assert.deepEqual(utf16z("中a"), Buffer.from([0x2d, 0x4e, 0x61, 0x00, 0x00, 0x00]));
});

test("buildDropFiles：20 字节头 + 路径以 0 结尾 + 末尾多一个 0，宽字符标记打开", () => {
  const data = buildDropFiles(["C:\\a.jpg"]);
  assert.equal(data.readUInt32LE(0), 20);
  assert.equal(data.readUInt32LE(16), 1);
  assert.equal(data.subarray(20).toString("utf16le"), "C:\\a.jpg\0\0");
});

test("bgraToDib24：头 40 字节、从下往上排、每行补齐到 4 字节、丢掉透明位", () => {
  // 2x2：上排 红 绿，下排 蓝 白（每点 蓝绿红透明）
  const bgra = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]);
  const dib = bgraToDib24(bgra, 2, 2);
  assert.equal(dib.readUInt32LE(0), 40);
  assert.equal(dib.readInt32LE(4), 2);
  assert.equal(dib.readInt32LE(8), 2, "高度为正＝从下往上排");
  assert.equal(dib.readUInt16LE(14), 24);
  const rowBytes = 8; // 2 点 × 3 字节 = 6，补到 8
  assert.equal(dib.length, 40 + rowBytes * 2);
  assert.deepEqual([...dib.subarray(40, 46)], [255, 0, 0, 255, 255, 255], "第一行是原图下排：蓝 白");
  assert.deepEqual([...dib.subarray(48, 54)], [0, 0, 255, 0, 255, 0], "第二行是原图上排：红 绿");
  assert.throws(() => bgraToDib24(Buffer.alloc(3), 2, 2));
});
