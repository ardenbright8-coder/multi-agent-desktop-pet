// vivo 拖图补丁还在不在（2026-10-18 用户拍板装的补丁）：补丁改的是 vivo 自己的程序包 app.asar，
// vivo 一升级就被盖掉。这里开机看一眼：只读程序包开头的目录和弹窗那一个小文件（几十 KB），找补丁记号。
// 补丁本体、装补丁和退回原版的脚本都在 PATCH_DIR，不在桌宠里。
import { closeSync, existsSync, openSync, readSync } from "node:fs";

export const VIVO_ASAR = "C:\\Program Files (x86)\\pcsuite\\resources\\app.asar";
export const PATCH_DIR = process.env.VIVO拖图补丁夹 || "D:\\Downloads\\vivo办公套件\\拖图补丁";
const MARK = "AGENTPET_VIVO_DRAG_PATCH_v1";
const POPUP = ["dist", "electron", "174.js"];

export type DragPatchState = "已装" | "被升级盖掉了" | "没装 vivo" | "看不出来";

export function checkDragPatch(asar = VIVO_ASAR): DragPatchState {
  if (!existsSync(asar)) return "没装 vivo";
  const fd = openSync(asar, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    let node = JSON.parse(json.toString());
    for (const part of POPUP) node = node?.files?.[part];
    if (!node || node.offset === undefined) return "看不出来";
    const body = Buffer.alloc(node.size);
    readSync(fd, body, 0, node.size, 8 + head.readUInt32LE(4) + Number(node.offset));
    return body.toString().includes(MARK) ? "已装" : "被升级盖掉了";
  } finally {
    closeSync(fd);
  }
}
