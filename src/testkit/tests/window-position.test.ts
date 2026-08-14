import assert from "node:assert/strict";
import test from "node:test";
import { clampWindowPosition, defaultWindowPosition } from "../../pet/window-position";

const size = { width: 440, height: 680 };

const petSize = { width: 220, height: 304 };

test("default position keeps the pet at the top-right corner (small floating bubble)", () => {
  // 右上角小浮窗（2026-08-14 用户定规格）：距顶/右默认 margin 28 逻辑像素
  assert.deepEqual(defaultWindowPosition({ x: 0, y: 0, width: 1920, height: 1040 }, petSize), { x: 1672, y: 28 });
});

test("default position never sinks past the bottom margin on a short screen", () => {
  // 矮屏幕上 2/3 会算到底边以下，得被底边规则接住
  const shortArea = { x: 0, y: 0, width: 1920, height: 500 };
  const position = defaultWindowPosition(shortArea, petSize);
  assert.ok(position.y + petSize.height <= shortArea.height, `窗口沉到屏幕外了：${JSON.stringify(position)}`);
});

test("restored position is clamped fully into its visible display", () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(clampWindowPosition({ x: 1900, y: 1000 }, areas, size), { x: 1480, y: 360 });
  assert.deepEqual(clampWindowPosition({ x: -900, y: -800 }, areas, size), { x: 0, y: 0 });
});

test("position follows the nearest remaining display after display removal", () => {
  const areas = [{ x: -1280, y: 0, width: 1280, height: 1024 }, { x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(clampWindowPosition({ x: -1000, y: 200 }, areas, size), { x: -1000, y: 200 });
  assert.deepEqual(clampWindowPosition({ x: 2500, y: 200 }, [areas[1]], size), { x: 1480, y: 200 });
});

test("pet-only bounds may reach screen edges while the transparent window extends offscreen", () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const petBounds = { x: 218, y: 392, width: 213, height: 247 };
  assert.deepEqual(clampWindowPosition({ x: -400, y: -500 }, areas, size, petBounds), { x: -218, y: -392 });
  assert.deepEqual(clampWindowPosition({ x: 1900, y: 1000 }, areas, size, petBounds), { x: 1489, y: 401 });
});
