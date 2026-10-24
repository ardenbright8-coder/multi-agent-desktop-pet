// vivo 拖图补丁检查单测：拿假的程序包（照 vivo app.asar 的格式拼）看认不认得出补丁记号。不碰真 vivo。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkDragPatch, patchCmd } from "../../vivo/drag-patch";

test("patchCmd：开机提醒里让他双击的那个文件真的在（配套夹改名了这里会红）", () => {
  assert.ok(existsSync(patchCmd(resolve(__dirname, "../../.."))));
});

// 弹窗分块的文件名每版不同（8 月版 174.js、7.0.6 版 184.js），检查不许写死名字
function fakeAsar(popup: string, chunk = "174.js"): string {
  const body = Buffer.from(popup);
  const header = { files: { dist: { files: { electron: { files: { [chunk]: { size: body.length, offset: "0" } } } } } } };
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded, 4);
  head.writeUInt32LE(4 + padded, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  const dir = mkdtempSync(join(tmpdir(), "vivo-asar-"));
  const file = join(dir, "app.asar");
  writeFileSync(file, Buffer.concat([head, body]));
  return file;
}

test("checkDragPatch：有记号=已装，没记号=被升级盖掉了，没文件=没装 vivo", () => {
  const patched = fakeAsar("a(){/*AGENTPET_VIVO_DRAG_PATCH_v1*/}");
  const plain = fakeAsar("a(){}");
  const newer = fakeAsar("a(){/*AGENTPET_VIVO_DRAG_PATCH_v1*/}", "184.js");
  try {
    assert.equal(checkDragPatch(patched), "已装");
    assert.equal(checkDragPatch(plain), "被升级盖掉了");
    assert.equal(checkDragPatch(newer), "已装");
    assert.equal(checkDragPatch(join(tmpdir(), "没有这个文件.asar")), "没装 vivo");
  } finally {
    for (const f of [patched, plain, newer]) rmSync(join(f, ".."), { recursive: true, force: true });
  }
});
