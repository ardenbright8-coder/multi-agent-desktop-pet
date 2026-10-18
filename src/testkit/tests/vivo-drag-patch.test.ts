// vivo 拖图补丁检查单测：拿假的程序包（照 vivo app.asar 的格式拼）看认不认得出补丁记号。不碰真 vivo。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDragPatch } from "../../vivo/drag-patch";

function fakeAsar(popup: string): string {
  const body = Buffer.from(popup);
  const header = { files: { dist: { files: { electron: { files: { "174.js": { size: body.length, offset: "0" } } } } } } };
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
  try {
    assert.equal(checkDragPatch(patched), "已装");
    assert.equal(checkDragPatch(plain), "被升级盖掉了");
    assert.equal(checkDragPatch(join(tmpdir(), "没有这个文件.asar")), "没装 vivo");
  } finally {
    rmSync(join(patched, ".."), { recursive: true, force: true });
    rmSync(join(plain, ".."), { recursive: true, force: true });
  }
});
