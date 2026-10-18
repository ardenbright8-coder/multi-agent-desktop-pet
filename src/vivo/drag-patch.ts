// vivo 拖图补丁还在不在（2026-10-18 用户拍板装的补丁）：补丁改的是 vivo 自己的程序包 app.asar，
// vivo 一升级就被盖掉。这里开机看一眼：只读程序包开头的目录和弹窗那一个小文件（几十 KB），找补丁记号。
// 补丁脚本在代码夹 `vivo配套（…）\拖图补丁\`（不进桌宠程序），大文件备份在 D 盘。
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const VIVO_ASAR = "C:\\Program Files (x86)\\pcsuite\\resources\\app.asar";
export const KIT_DIR_NAME = "vivo配套（拖图补丁·插件·一键装）";

/** 双击重装补丁的那个文件。appRoot = 桌宠代码夹（app.getAppPath()） */
export function patchCmd(appRoot: string): string {
  return join(appRoot, KIT_DIR_NAME, "拖图补丁", "双击装补丁.cmd");
}
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
