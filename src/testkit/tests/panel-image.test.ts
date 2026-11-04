// 面板附言里的图（2026-11-04）：粘进来的图存进 24 小时临时夹，别的格式、超大的一律不收，过期的自己删。

import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { panelImageDirectory, savePanelImage } from "../../channel/ipc-handlers";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("粘进来的 png 存成「附图_日期时间」文件，内容原样", () => {
  const file = savePanelImage(`data:image/png;base64,${PNG_1PX}`, new Date(2026, 10, 4, 5, 6, 7));
  assert.ok(file, "要存得下");
  try {
    assert.ok(file.startsWith(panelImageDirectory()));
    assert.match(file, /附图_2026-11-04_05-06-07_\w{4}\.png$/);
    assert.deepEqual(readFileSync(file), Buffer.from(PNG_1PX, "base64"));
  } finally {
    if (file && existsSync(file)) unlinkSync(file);
  }
});

test("不是图、乱写的一律不收", () => {
  assert.equal(savePanelImage("data:text/html;base64,PGh0bWw+"), null);
  assert.equal(savePanelImage("data:image/png;base64,"), null);
  assert.equal(savePanelImage("C:\\\\Windows\\\\win.ini"), null);
  assert.equal(savePanelImage(42), null);
});

test("超过 24 小时的旧图，下次存图时顺手删掉", () => {
  const first = savePanelImage(`data:image/png;base64,${PNG_1PX}`);
  assert.ok(first);
  const stale = join(panelImageDirectory(), "附图_老的.png");
  writeFileSync(stale, "x");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const second = savePanelImage(`data:image/png;base64,${PNG_1PX}`);
  try {
    assert.equal(existsSync(stale), false, "过期的要删");
    assert.equal(existsSync(first), true, "没过期的留着");
  } finally {
    for (const file of [first, second, stale]) if (file && existsSync(file)) unlinkSync(file);
  }
});
