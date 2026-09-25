// 看板字号单测：档位夹取 / 走档 / 存档解析 / 哪个键算调字号（按键接线和存盘在 panel-window）。

import assert from "node:assert/strict";
import test from "node:test";
import { clampZoom, DEFAULT_BOARD_ZOOM, parseZoom, stepZoom, zoomActionForKey } from "../../bookmark/zoom";

test("stepZoom：一档 10%，到 50% / 200% 停住，连按不攒浮点误差", () => {
  assert.equal(stepZoom(1, "in"), 1.1);
  assert.equal(stepZoom(1, "out"), 0.9);
  assert.equal(stepZoom(2, "in"), 2);
  assert.equal(stepZoom(0.5, "out"), 0.5);
  let zoom = 1;
  for (let i = 0; i < 7; i += 1) zoom = stepZoom(zoom, "in");
  assert.equal(zoom, 1.7);
  for (let i = 0; i < 7; i += 1) zoom = stepZoom(zoom, "out");
  assert.equal(zoom, 1);
});

test("clampZoom：非数字回落默认，越界夹边", () => {
  assert.equal(clampZoom(Number.NaN), DEFAULT_BOARD_ZOOM);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(9), 2);
});

test("parseZoom：好档取值，缺文件/坏档/越界回落默认", () => {
  assert.equal(parseZoom('{"zoom":1.3}'), 1.3);
  assert.equal(parseZoom(""), DEFAULT_BOARD_ZOOM);
  assert.equal(parseZoom("不是JSON"), DEFAULT_BOARD_ZOOM);
  assert.equal(parseZoom('{"zoom":"1.3"}'), DEFAULT_BOARD_ZOOM);
  assert.equal(parseZoom('{"zoom":5}'), DEFAULT_BOARD_ZOOM);
});

test("zoomActionForKey：Ctrl+等号不用 Shift 就放大，减号缩小，0 回原样；不按 Ctrl 或带 Alt 不认", () => {
  assert.equal(zoomActionForKey({ key: "=", control: true }), "in");
  assert.equal(zoomActionForKey({ key: "+", control: true }), "in");
  assert.equal(zoomActionForKey({ key: "+", code: "NumpadAdd", control: true }), "in");
  assert.equal(zoomActionForKey({ key: "-", control: true }), "out");
  assert.equal(zoomActionForKey({ key: "-", code: "NumpadSubtract", control: true }), "out");
  assert.equal(zoomActionForKey({ key: "0", control: true }), "reset");
  assert.equal(zoomActionForKey({ key: "=", control: false }), null);
  assert.equal(zoomActionForKey({ key: "=", control: true, alt: true }), null);
  assert.equal(zoomActionForKey({ key: "r", control: true }), null);
});
