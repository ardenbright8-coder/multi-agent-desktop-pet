// vivo 拖图补丁还在不在（2026-10-18 用户拍板装的补丁）：补丁改的是 vivo 自己的程序包 app.asar，
// vivo 一升级就被盖掉。这里开机看一眼：只读程序包开头的目录和弹窗那几个小分块，找补丁记号。
// 补丁脚本在代码夹 `vivo配套（…）\拖图补丁\`（不进桌宠程序），大文件备份在 D 盘。
// 2026-11-01 起两套系统共用 F 盘一份 vivo（SHARED_VIVO_DIR），补丁打一次两边都有；哪套还登记在自己 C 盘，就提醒它双击登记脚本。
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";

// 🚨 Electron 里普通 fs 把 .asar 当成文件夹：existsSync 说有、openSync 却报 ENOENT（2026-10-24 开机天天报「看 vivo 拖图补丁出错」）。
// 要把 .asar 当普通文件读得用 Electron 的 original-fs；单测跑在普通 Node 里没有它，就用 node:fs。
const fs: typeof nodeFs = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("original-fs") as typeof nodeFs;
  } catch {
    return nodeFs;
  }
})();

const DEFAULT_VIVO_DIR = "C:\\Program Files (x86)\\pcsuite";
/** 两套系统共用的那份 vivo（2026-11-01 他定：别散装，放 F 统一）。每套系统双击里面的登记脚本接上 */
export const SHARED_VIVO_DIR = "F:\\程序\\0072_vivo办公套件";
export const SHARED_REGISTER_CMD = join(SHARED_VIVO_DIR, "在这套系统上登记（vivo指向F盘这份）.cmd");
export const KIT_DIR_NAME = "vivo配套（拖图补丁·插件·一键装）";

/** 这套系统登记的 vivo 装在哪：看安装程序写的 InstPath（登记脚本搬家时会改它）。reg.exe 吐的是 GBK，用 PowerShell 读才不乱码 */
export function vivoInstallDir(): string {
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WOW6432Node\\pcsuite' -ErrorAction SilentlyContinue).InstPath",
    ], { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim();
    if (out) return out.replace(/\\+$/, "");
  } catch {
    // 读不到就当默认位置
  }
  return DEFAULT_VIVO_DIR;
}

export function vivoAsar(dir = vivoInstallDir()): string {
  return join(dir, "resources", "app.asar");
}

/** 这套系统的 vivo 还没接到 F 盘共用那份（共用那份在、这套却登记在别处） */
export function needsSharedRegister(dir: string): boolean {
  return fs.existsSync(join(SHARED_VIVO_DIR, "pcsuite.exe")) && dir.toLowerCase() !== SHARED_VIVO_DIR.toLowerCase();
}

/** 双击重装补丁的那个文件。appRoot = 桌宠代码夹（app.getAppPath()） */
export function patchCmd(appRoot: string): string {
  return join(appRoot, KIT_DIR_NAME, "拖图补丁", "双击装补丁.cmd");
}
// 补丁升版就升这个号（跟 打补丁.cjs 的 MARK 一致）。v2（2026-10-24）：点图复制、弹窗回右下角
const MARK = "AGENTPET_VIVO_DRAG_PATCH_v2";
const MARK_ANY = "AGENTPET_VIVO_DRAG_PATCH_v";
/** 弹窗分块在 dist/electron 下，文件名每版不同（8 月版 174.js，7.0.6 版 184.js），所以挨个小分块找记号。 */
const CHUNK_DIR = ["dist", "electron"];
/** 主程序 main.js 好几兆，不读；分块都小，超过这个大小的跳过。 */
const MAX_CHUNK = 1024 * 1024;

export type DragPatchState = "已装" | "装的是旧版补丁" | "被升级盖掉了" | "没装 vivo" | "看不出来";

interface AsarEntry {
  size?: number;
  offset?: string;
  unpacked?: boolean;
  files?: Record<string, AsarEntry>;
}

export function checkDragPatch(asar = vivoAsar()): DragPatchState {
  if (!fs.existsSync(asar)) return "没装 vivo";
  const fd = fs.openSync(asar, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    let dir = JSON.parse(json.toString()) as AsarEntry;
    for (const part of CHUNK_DIR) dir = dir?.files?.[part] as AsarEntry;
    if (!dir?.files) return "看不出来";
    const base = 8 + head.readUInt32LE(4);
    let chunks = 0;
    let older = false;
    for (const [name, node] of Object.entries(dir.files)) {
      if (!name.endsWith(".js") || name === "main.js" || node.unpacked || node.offset === undefined || !node.size || node.size > MAX_CHUNK) continue;
      chunks++;
      const body = Buffer.alloc(node.size);
      fs.readSync(fd, body, 0, node.size, base + Number(node.offset));
      const text = body.toString();
      if (text.includes(MARK)) return "已装";
      if (text.includes(MARK_ANY)) older = true;
    }
    if (older) return "装的是旧版补丁";
    return chunks ? "被升级盖掉了" : "看不出来";
  } finally {
    fs.closeSync(fd);
  }
}
