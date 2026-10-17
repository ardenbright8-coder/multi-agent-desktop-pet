// Agent命令快捷窗口要用的 Windows 能力，全走 koffi。惰性加载，加载失败只记一次日志，窗口整个不启用（不连坐桌宠、看板）。
// 跟看板那份（bookmark/panel-window 的 loadLaunchWin32）各写各的：两块互不 import，koffi 的类型名也各起各的（Qc 开头）。
// HWND 一律 uintptr_t + BigInt（看板实测 void* + Buffer 会静默失败）。

import { createLogger } from "../shared/log";

const log = createLogger("quickcmd");

export interface QuickWin32 {
  foreground(): bigint;
  isWindow(hwnd: bigint): boolean;
  /** 窗口在屏幕上的位置，物理像素（还没换算成 Electron 那套坐标）。 */
  rectOf(hwnd: bigint): { x: number; y: number; width: number; height: number } | null;
  /** 这个窗口是哪个程序（完整路径，问不出给空串）。 */
  processOf(hwnd: bigint): string;
  /** 按一下再松开一个键。🚨 只按传进来的这一个键，不带回车。 */
  pressKey(vk: number): void;
  /** 鼠标左键或右键现在是不是按着。点到窗口外面就收，靠它看。 */
  mouseDown(): boolean;
  /** 鼠标现在在哪，物理像素。 */
  cursor(): { x: number; y: number } | null;
}

let cached: QuickWin32 | null | undefined;

export function loadQuickWin32(): QuickWin32 | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    koffi.struct("QcRect", { left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
    koffi.struct("QcPoint", { x: "int32_t", y: "int32_t" });
    const getAsyncKeyState = user32.func("int16_t __stdcall GetAsyncKeyState(int32_t vKey)") as unknown as (vk: number) => number;
    const getCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ QcPoint *point)") as unknown as (point: { x: number; y: number }) => boolean;

    const getForeground = user32.func("uintptr_t __stdcall GetForegroundWindow()") as unknown as () => number | bigint;
    const isWindow = user32.func("bool __stdcall IsWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const getWindowRect = user32.func("bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ QcRect *rect)") as unknown as (
      hwnd: bigint,
      rect: { left: number; top: number; right: number; bottom: number },
    ) => boolean;
    const getWindowPid = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)") as unknown as (
      hwnd: bigint,
      pid: number[],
    ) => number;
    const keybdEvent = user32.func(
      "void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)",
    ) as unknown as (vk: number, scan: number, flags: number, extra: number) => void;
    const openProcess = kernel32.func("uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)") as unknown as (
      access: number,
      inherit: boolean,
      pid: number,
    ) => number | bigint;
    const queryImageName = kernel32.func(
      "bool __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)",
    ) as unknown as (process: number | bigint, flags: number, name: Uint16Array, size: number[]) => boolean;
    const closeHandle = kernel32.func("bool __stdcall CloseHandle(uintptr_t handle)") as unknown as (handle: number | bigint) => boolean;

    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const KEYEVENTF_KEYUP = 0x0002;

    cached = {
      foreground: () => BigInt(getForeground()),
      isWindow: (hwnd) => isWindow(hwnd),
      rectOf: (hwnd) => {
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        if (!getWindowRect(hwnd, rect)) return null;
        return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
      },
      processOf: (hwnd) => {
        const pid = [0];
        getWindowPid(hwnd, pid);
        if (!pid[0]) return "";
        const process = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
        if (!process) return "";
        try {
          const name = new Uint16Array(1024);
          const size = [name.length];
          return queryImageName(process, 0, name, size) ? String.fromCharCode(...name.subarray(0, size[0])) : "";
        } finally {
          closeHandle(process);
        }
      },
      pressKey: (vk) => {
        keybdEvent(vk, 0, 0, 0);
        keybdEvent(vk, 0, KEYEVENTF_KEYUP, 0);
      },
      // 最高位＝现在按着。左键 0x01、右键 0x02。
      mouseDown: () => (getAsyncKeyState(0x01) & 0x8000) !== 0 || (getAsyncKeyState(0x02) & 0x8000) !== 0,
      cursor: () => {
        const point = { x: 0, y: 0 };
        return getCursorPos(point) ? point : null;
      },
    };
  } catch (error) {
    cached = null;
    log.出事("Windows 接口加载失败，Agent命令快捷窗口不启用（终端自己的 Ctrl+Q 弹框照样能用）", error, "win32");
  }
  return cached;
}
