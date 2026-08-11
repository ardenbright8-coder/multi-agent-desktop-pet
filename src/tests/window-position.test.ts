import assert from "node:assert/strict";
import test from "node:test";
import { clampWindowPosition, defaultWindowPosition } from "../main/window-position";

const size = { width: 440, height: 680 };

test("default position uses the primary work area's lower-right spacing", () => {
  assert.deepEqual(defaultWindowPosition({ x: 0, y: 0, width: 1920, height: 1040 }, size), { x: 1452, y: 338 });
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
