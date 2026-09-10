import assert from "node:assert/strict";
import test from "node:test";
import { computeDockedBounds, parseSavedWindowSize, HWND_BOTTOM, SWP_SINK_FLAGS } from "../../bookmark/dock";

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

test("看板贴右缘：宽 = 工作区宽 ÷ 3，高 = 工作区全高", () => {
  const b = computeDockedBounds(workArea);
  assert.equal(b.width, Math.round(1920 / 3));
  assert.equal(b.height, 1040);
});

test("看板 x = 右缘减去自身宽，y = 工作区顶", () => {
  const b = computeDockedBounds(workArea);
  assert.equal(b.x, 1920 - b.width);
  assert.equal(b.y, 0);
});

test("带偏移的多屏工作区（任务栏在左/上）也对齐", () => {
  const b = computeDockedBounds({ x: 100, y: 50, width: 3000, height: 1200 });
  assert.equal(b.width, 1000);
  assert.equal(b.x, 100 + 3000 - 1000);
  assert.equal(b.y, 50);
  assert.equal(b.height, 1200);
});

test("窄屏兜底：宽至少 320，不许挤没了", () => {
  const b = computeDockedBounds({ x: 0, y: 0, width: 600, height: 800 });
  assert.equal(b.width, 320);
  assert.equal(b.x, 600 - 320);
});

test("Win32 沉底参数：压到最底、不动位置尺寸、不抢激活", () => {
  assert.equal(HWND_BOTTOM, 1);
  // SWP_NOSIZE(0x1) | SWP_NOMOVE(0x2) | SWP_NOACTIVATE(0x10)
  assert.equal(SWP_SINK_FLAGS, 0x13);
});

// ── 用户拍板（2026-09-10）：默认尺寸=用户拖的尺寸，记住手动调整，以后默认开就这个 ──

const saved = { width: 1025, height: 1399 };

// 工作区 ≥ 存档尺寸（不触发夹取），验“存档原样生效”。
const bigWorkArea = { x: 0, y: 0, width: 2560, height: 1399 };

test("传存档尺寸：用存档的宽高，仍贴右缘顶到底", () => {
  const b = computeDockedBounds(bigWorkArea, saved);
  assert.equal(b.width, 1025);
  assert.equal(b.height, 1399);
  assert.equal(b.x, 2560 - 1025);
  assert.equal(b.y, 0);
});

test("换小屏：存档超屏被夹住（高夹到工作区高，不出屏）", () => {
  // 用户在大屏拖的尺寸拿到小屏开，高超出屏的部分必须夹掉，否则窗口底部看不见。
  const b = computeDockedBounds(workArea, saved);
  assert.equal(b.width, 1025);
  assert.equal(b.height, 1040);
  assert.equal(b.x, 1920 - 1025);
  assert.equal(b.y, 0);
});

test("存档尺寸不合法时兜底：宽至少 320、高不超屏、高至少 200", () => {
  // 宽窄过下限 → 320；高超屏 → 夹到工作区全高。
  const clamped = computeDockedBounds(workArea, { width: 100, height: 99999 });
  assert.equal(clamped.width, 320);
  assert.equal(clamped.height, 1040);
  // 宽超屏 → 夹到工作区全宽；高矮过下限 → 200。
  const wide = computeDockedBounds(workArea, { width: 99999, height: 100 });
  assert.equal(wide.width, 1920);
  assert.equal(wide.height, 200);
});

test("不传存档尺寸：行为跟旧版完全一样（1/3 宽顶到底）", () => {
  const b = computeDockedBounds(workArea, undefined);
  assert.equal(b.width, Math.round(1920 / 3));
  assert.equal(b.height, 1040);
});

test("parseSavedWindowSize：好 JSON 过，小数取整", () => {
  assert.deepEqual(parseSavedWindowSize('{"width":1025.4,"height":1399.6}'), { width: 1025, height: 1400 });
  assert.deepEqual(parseSavedWindowSize('{"width":800,"height":600}'), { width: 800, height: 600 });
});

test("parseSavedWindowSize：垃圾数据一律 null（坏档不炸照 store 先例）", () => {
  assert.equal(parseSavedWindowSize("不是JSON"), null);
  assert.equal(parseSavedWindowSize("[]"), null);
  assert.equal(parseSavedWindowSize("null"), null);
  assert.equal(parseSavedWindowSize('{"width":"800","height":600}'), null); // 字符串宽不要
  assert.equal(parseSavedWindowSize('{"width":0,"height":600}'), null); // 零宽不要
  assert.equal(parseSavedWindowSize('{"width":-5,"height":600}'), null); // 负数不要
  assert.equal(parseSavedWindowSize('{}'), null); // 缺字段不要
  assert.equal(parseSavedWindowSize(""), null);
});
