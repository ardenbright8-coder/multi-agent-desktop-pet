// 交互弹窗（权限／询问）出现时把桌宠窗口拉到最前并接住键盘，收起后把前台还给原来那扇窗（2026-11-14）。
// 与 bookmark 各自保留一份 Win32 绑定，两块互不 import（遵循模块边界规矩）。

import { createLogger } from "../shared/log";
import { isIsolatedRun } from "../shared/paths";

const log = createLogger("window");

export interface PetFocusWin32 {
  foreground(): bigint;
  isWindow(hwnd: bigint): boolean;
  /** 把指定 HWND 拿到 Windows 前台（挂接当前前台线程后调 SetForegroundWindow）。 */
  bringToFront(hwnd: bigint): boolean;
}

export interface PanelFocusTrackerDeps {
  getWin32(): PetFocusWin32 | null;
  getSelfHwnd(): bigint;
  /** steal=true 首次切到桌宠拿键盘焦点；steal=false 仅保持最上层（排队切下一条或微调高度时）。 */
  focusPetWindow(steal: boolean): void;
}

/**
 * 追踪交互弹窗是否处于「已接管键盘焦点」状态，保证两点：
 * 1. 只在初次从无弹窗进入交互弹窗时记录原前台窗口，队列连续切下一条时不覆盖；
 * 2. 只在收起后且当前前台仍在桌宠自己、且未主动点了「返回终端」时才还焦点。
 */
export class PanelFocusTracker {
  private focused = false;
  private priorHwnd = 0n;
  private skipRestore = false;

  constructor(private readonly deps: PanelFocusTrackerDeps) {}

  /** 当交互面板显隐切换（仅包含权限／询问，不含完成提醒）时调用。 */
  sync(focusPanel: boolean): void {
    const win32 = this.deps.getWin32();
    const selfHwnd = this.deps.getSelfHwnd();

    if (focusPanel) {
      if (!this.focused) {
        this.focused = true;
        this.skipRestore = false;
        const before = win32 ? win32.foreground() : 0n;
        this.priorHwnd = before !== 0n && before !== selfHwnd ? before : 0n;
        // 先借 Win32 挂接前台线程把 HWND 切进前台，再调 Electron focus()，确保网页侧 document.hasFocus() 真到位
        if (win32 && selfHwnd !== 0n && before !== selfHwnd) {
          const ok = win32.bringToFront(selfHwnd);
          if (!ok) log.调试("交互弹窗请求抢前台被系统拒绝，已退回 Electron focus()", "panelFocus");
        }
        this.deps.focusPetWindow(true);
        return;
      }
      this.deps.focusPetWindow(false);
      return;
    }

    if (!this.focused) return;
    this.focused = false;
    const target = this.skipRestore ? 0n : this.priorHwnd;
    this.priorHwnd = 0n;
    this.skipRestore = false;
    if (!win32 || target === 0n) return;
    if (win32.foreground() !== selfHwnd) return;
    if (!win32.isWindow(target)) return;
    win32.bringToFront(target);
  }

  /** 用户点了「返回终端」主动切去 Agent 窗口，随后的收起不再还给更早的旧窗口。 */
  markSkipRestore(): void {
    this.skipRestore = true;
    this.priorHwnd = 0n;
  }

  /** 窗口销毁时清干净状态。 */
  reset(): void {
    this.focused = false;
    this.priorHwnd = 0n;
    this.skipRestore = false;
  }
}

let cachedWin32: PetFocusWin32 | null | undefined;

/** 惰性加载 Win32 前台切换能力；测试隔离运行或非 Windows 时返回 null，绝不抢真机窗口。 */
export function loadPetFocusWin32(): PetFocusWin32 | null {
  if (cachedWin32 !== undefined) return cachedWin32;
  if (process.platform !== "win32" || isIsolatedRun()) {
    cachedWin32 = null;
    return cachedWin32;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const getForeground = user32.func("uintptr_t __stdcall GetForegroundWindow()") as unknown as () => number | bigint;
    const setForeground = user32.func("bool __stdcall SetForegroundWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const isWindow = user32.func("bool __stdcall IsWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const threadOf = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, uintptr_t pid)") as unknown as (
      hwnd: bigint,
      pid: number,
    ) => number;
    const attachInput = user32.func("bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)") as unknown as (
      from: number,
      to: number,
      attach: boolean,
    ) => boolean;
    const currentThread = kernel32.func("uint32_t __stdcall GetCurrentThreadId()") as unknown as () => number;

    cachedWin32 = {
      foreground: () => BigInt(getForeground()),
      isWindow: (hwnd) => hwnd !== 0n && isWindow(hwnd),
      bringToFront: (hwnd) => {
        const fg = BigInt(getForeground());
        if (fg === hwnd) return true;
        const me = currentThread();
        const fgThread = fg !== 0n ? threadOf(fg, 0) : 0;
        const attached = fgThread !== 0 && fgThread !== me && attachInput(me, fgThread, true);
        try {
          return setForeground(hwnd);
        } finally {
          if (attached) attachInput(me, fgThread, false);
        }
      },
    };
  } catch (error) {
    cachedWin32 = null;
    log.出事("桌宠抢/还焦点用的 Windows 接口加载失败（退回普通弹窗，需先点一下）", error, "panelFocus");
  }
  return cachedWin32;
}

/** 安全读取 Electron BrowserWindow 的原生 HWND（失败或非 64 位长度返回 0n）。 */
export function readWindowHwnd(handle: Buffer | null | undefined): bigint {
  if (!handle || handle.length < 4) return 0n;
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}
