// 看板外观设置单测：透明度解析/夹取纯函数（存取的 IO 在 panel-window，纯逻辑归这里测）。

import assert from "node:assert/strict";
import test from "node:test";
import { clampOpacity, DEFAULT_BOARD_OPACITY, parseAppearance } from "../../bookmark/appearance";

test("parseAppearance：好档取值，缺文件/坏档/越界回落默认", () => {
  assert.equal(parseAppearance('{"opacity":0.42}'), 0.42);
  assert.equal(parseAppearance(""), DEFAULT_BOARD_OPACITY);
  assert.equal(parseAppearance("不是JSON"), DEFAULT_BOARD_OPACITY);
  assert.equal(parseAppearance("[]"), DEFAULT_BOARD_OPACITY);
  assert.equal(parseAppearance('{"opacity":"0.5"}'), DEFAULT_BOARD_OPACITY);
  assert.equal(parseAppearance('{"opacity":3}'), DEFAULT_BOARD_OPACITY);
  assert.equal(parseAppearance("{}"), DEFAULT_BOARD_OPACITY);
});

test("clampOpacity：范围 0.30–0.95，越界夹边", () => {
  assert.equal(clampOpacity(0.6), 0.6);
  assert.equal(clampOpacity(0.1), 0.3);
  assert.equal(clampOpacity(0.99), 0.95);
  assert.equal(clampOpacity(Number.NaN), DEFAULT_BOARD_OPACITY);
});
