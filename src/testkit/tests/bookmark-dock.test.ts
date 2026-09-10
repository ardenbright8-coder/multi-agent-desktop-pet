import assert from "node:assert/strict";
import test from "node:test";
import { computeDockedBounds, HWND_BOTTOM, SWP_SINK_FLAGS } from "../../bookmark/dock";

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
