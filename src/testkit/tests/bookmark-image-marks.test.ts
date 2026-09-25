// 图片标注（设定16第三版）：标注清洗、给 AI 的编号清单、交给 AI 时带编号图＋原图＋清单。
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { describeMarks, imagesForAgent, markedFileName, parseMarks, parseMarkSet, sanitizeMarks, type ImageMark } from "../../bookmark/inline-images";
import { attachmentsRoot } from "../../shared/paths";

const marks: ImageMark[] = [
  { kind: "pin", x: 0.12, y: 0.3, endX: 0.12, endY: 0.3, note: "这个按钮改成绿色" },
  { kind: "box", x: 0.4, y: 0.35, endX: 0.1, endY: 0.2, note: "" },
  { kind: "arrow", x: 0.2, y: 0.7, endX: 0.6, endY: 0.7, note: "把左边这个挪到这里" },
];

test("sanitizeMarks：认不出的丢掉，坐标夹到 0～1，说明截长", () => {
  const clean = sanitizeMarks([
    { kind: "pin", x: 1.5, y: -2, note: "x".repeat(900) },
    { kind: "text", x: 0.1, y: 0.1 },
    { kind: "box", x: "0.1", y: 0.1 },
    null,
  ]);
  assert.equal(clean.length, 1);
  assert.deepEqual([clean[0].x, clean[0].y, clean[0].endX, clean[0].endY], [1, 0, 1, 0]);
  assert.equal(clean[0].note.length, 500);
  assert.deepEqual(sanitizeMarks("不是数组"), []);
  assert.deepEqual(parseMarks("坏档"), []);
  assert.equal(parseMarks(JSON.stringify({ marks })).length, 3);
});

test("describeMarks：全图一套流水号，写清是标注 / 框 / 箭头、在哪、说了什么；标注和箭头只说大约这附近", () => {
  const lines = describeMarks(marks);
  assert.equal(lines[0], "① 标注，大约在（从左 12%、从上 30%）这附近：这个按钮改成绿色");
  assert.equal(lines[1], "② 框，这一块范围内：（从左 10%、从上 20%）到（从左 40%、从上 35%）：（没写说明，看图上这个位置）");
  assert.equal(lines[2], "③ 箭头，从（从左 20%、从上 70%）这附近指到（从左 60%、从上 70%）这附近：把左边这个挪到这里");
});

test("imagesForAgent：标过的图给带编号那张＋原图＋清单，没标的照旧只给原图", () => {
  const text = "改这里 [图片:image-aaa.png] 还有 [图片:image-bbb.png]";
  const out = imagesForAgent(text, (name) => (name === "image-aaa.png" ? { marks, summary: "整体再清爽一点", marked: true } : { marks: [], summary: "", marked: false }));
  assert.ok(out.includes(`图片文件（标了编号的）：${join(attachmentsRoot(), markedFileName("image-aaa.png"))}`));
  assert.ok(out.includes(`原图：${join(attachmentsRoot(), "image-aaa.png")}`));
  assert.ok(out.includes("用户在图上标了 3 处"));
  assert.ok(out.includes("③ 箭头"));
  assert.ok(out.indexOf("整张图的说明：整体再清爽一点") < out.indexOf("① 标注"));
  assert.ok(out.includes(`图片文件：${join(attachmentsRoot(), "image-bbb.png")}`));
  assert.ok(out.indexOf("改这里") < out.indexOf("image-aaa.png") && out.indexOf("③ 箭头") < out.indexOf("还有"));
  assert.ok(!out.includes("[图片:"));
});

test("imagesForAgent：只写了整体说明没画标注，给原图＋说明，不提带编号的图", () => {
  const out = imagesForAgent("看 [图片:image-ccc.png]", () => ({ marks: [], summary: "配色太暗", marked: false }));
  assert.ok(out.includes(`图片文件：${join(attachmentsRoot(), "image-ccc.png")}`));
  assert.ok(out.includes("整张图的说明：配色太暗"));
  assert.ok(!out.includes("标了") && !out.includes("图上标注"));
  assert.deepEqual(parseMarkSet(JSON.stringify({ marks: [], summary: "配色太暗" })), { marks: [], summary: "配色太暗" });
});
