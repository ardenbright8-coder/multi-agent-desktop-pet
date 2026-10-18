// vivo 截图复制单测：认不认 vivo 的图、拼「复制的文件」和「一张图」两种格式（往系统剪贴板放在 vivo/win32，这里不碰）。

import assert from "node:assert/strict";
import test from "node:test";
import { bgraToDib24, buildDropFiles, pickVivoImage, utf16z, vivoClipDirectory } from "../../vivo/clip-format";

const DIR = "C:\\Users\\某人\\AppData\\Roaming\\vivoClipdata";

test("vivoClipDirectory：默认在 APPDATA 下的 vivoClipdata，环境变量能改", () => {
  assert.equal(vivoClipDirectory({ APPDATA: "C:\\R" }), "C:\\R\\vivoClipdata");
  assert.equal(vivoClipDirectory({ APPDATA: "C:\\R", VIVO截图夹: "D:\\x" }), "D:\\x");
});

test("pickVivoImage：只认恰好一张、在 vivo 夹里的图片，大小写不敏感", () => {
  const file = `${DIR}\\temp_file_create_1_0.jpeg`;
  assert.equal(pickVivoImage([file], DIR), file);
  assert.equal(pickVivoImage([`${DIR.toUpperCase()}\\A.PNG`], DIR), `${DIR.toUpperCase()}\\A.PNG`);
  assert.equal(pickVivoImage([file, file], DIR), null, "复制了两个文件不碰");
  assert.equal(pickVivoImage([], DIR), null);
  assert.equal(pickVivoImage(["D:\\别处\\a.jpg"], DIR), null, "别的夹里的图不碰");
  assert.equal(pickVivoImage([`${DIR}x\\a.jpg`], DIR), null, "名字只是开头一样的夹不算");
  assert.equal(pickVivoImage([`${DIR}\\a.txt`], DIR), null, "不是图片不碰");
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
