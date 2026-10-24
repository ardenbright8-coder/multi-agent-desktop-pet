// vivo 截图复制要用的 Windows 剪贴板能力，全走 koffi。惰性加载，加载失败只记一次日志，这块整个不启用（不连坐别的板块）。
// 跟 quickcmd、看板那几份各写各的：几块互不 import。HWND、句柄一律 uintptr_t + BigInt（看板实测 void* + Buffer 会静默失败）。
//
// 为什么写剪贴板不用 Electron 自带的 clipboard：它只能放字、图、网页那几样，放不了「复制了一个文件」（CF_HDROP）。
// 读图用 Electron 的 clipboard.readImage 就够了（在 vivo-clip.ts）。

import { createLogger } from "../shared/log";

const log = createLogger("vivo");

export const CF_DIB = 8;
export const CF_UNICODETEXT = 13;
export const CF_HDROP = 15;

export interface VivoWin32 {
  /** 剪贴板每变一次这个数加一。不用打开剪贴板，很便宜，拿来轮询。 */
  sequence(): number;
  has(format: number): boolean;
  /** 起个名字换一个格式编号（「PNG」这种没有固定编号的格式要先换）。 */
  register(name: string): number;
  /** 清空剪贴板，一次放进去这几样。成功给 true。 */
  write(items: ReadonlyArray<{ format: number; data: Buffer }>): boolean;
  /** 剪贴板主人小窗口还在不在（被系统收掉了就放不进东西，要重建） */
  alive(): boolean;
  dispose(): void;
}

let cached: VivoWin32 | null | undefined;

export function loadVivoWin32(): VivoWin32 | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");

    const getSequence = user32.func("uint32_t __stdcall GetClipboardSequenceNumber()") as unknown as () => number;
    const isAvailable = user32.func("bool __stdcall IsClipboardFormatAvailable(uint32_t format)") as unknown as (format: number) => boolean;
    const registerFormat = user32.func("uint32_t __stdcall RegisterClipboardFormatW(str16 name)") as unknown as (name: string) => number;
    const openClipboard = user32.func("bool __stdcall OpenClipboard(uintptr_t owner)") as unknown as (owner: bigint) => boolean;
    const closeClipboard = user32.func("bool __stdcall CloseClipboard()") as unknown as () => boolean;
    const emptyClipboard = user32.func("bool __stdcall EmptyClipboard()") as unknown as () => boolean;
    const setData = user32.func("uintptr_t __stdcall SetClipboardData(uint32_t format, uintptr_t memory)") as unknown as (format: number, memory: bigint) => number | bigint;
    const createWindow = user32.func(
      "uintptr_t __stdcall CreateWindowExW(uint32_t exStyle, str16 className, str16 title, uint32_t style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t instance, uintptr_t param)",
    ) as unknown as (...args: unknown[]) => number | bigint;
    const destroyWindow = user32.func("bool __stdcall DestroyWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const isWindow = user32.func("bool __stdcall IsWindow(uintptr_t hwnd)") as unknown as (hwnd: bigint) => boolean;
    const globalAlloc = kernel32.func("uintptr_t __stdcall GlobalAlloc(uint32_t flags, size_t bytes)") as unknown as (flags: number, bytes: number) => number | bigint;
    const globalLock = kernel32.func("uintptr_t __stdcall GlobalLock(uintptr_t memory)") as unknown as (memory: bigint) => number | bigint;
    const globalUnlock = kernel32.func("bool __stdcall GlobalUnlock(uintptr_t memory)") as unknown as (memory: bigint) => boolean;
    const globalFree = kernel32.func("uintptr_t __stdcall GlobalFree(uintptr_t memory)") as unknown as (memory: bigint) => number | bigint;
    const copyMemory = kernel32.func("void __stdcall RtlMoveMemory(uintptr_t dest, _In_ uint8_t *src, size_t bytes)") as unknown as (dest: bigint, src: Buffer, bytes: number) => void;

    // 放东西进剪贴板得有个「主人」窗口：开个看不见、不进任务栏、只收消息的小窗口（HWND_MESSAGE＝-3）。
    // 不开的话 Windows 文档说 SetClipboardData 会失败。
    const HWND_MESSAGE = 0xfffffffffffffffdn;
    const owner = BigInt(createWindow(0, "STATIC", "AgentPetVivoClip", 0, 0, 0, 0, 0, HWND_MESSAGE, 0n, 0n, 0n));
    if (!owner) throw new Error("开不了剪贴板主人窗口（CreateWindowExW 返回 0）");

    const GMEM_MOVEABLE = 0x0002;

    const toMemory = (data: Buffer): bigint | null => {
      const memory = BigInt(globalAlloc(GMEM_MOVEABLE, data.length));
      if (!memory) return null;
      const pointer = BigInt(globalLock(memory));
      if (!pointer) {
        globalFree(memory);
        return null;
      }
      copyMemory(pointer, data, data.length);
      globalUnlock(memory);
      return memory;
    };

    cached = {
      sequence: () => getSequence(),
      has: (format) => isAvailable(format),
      register: (name) => registerFormat(name),
      write: (items) => {
        if (!openClipboard(owner)) return false;
        try {
          if (!emptyClipboard()) return false;
          let ok = true;
          for (const item of items) {
            const memory = toMemory(item.data);
            if (!memory) {
              ok = false;
              continue;
            }
            // 放成功了这块内存归 Windows 管；没成功得自己还回去
            if (!BigInt(setData(item.format, memory))) {
              globalFree(memory);
              ok = false;
            }
          }
          return ok;
        } finally {
          closeClipboard();
        }
      },
      alive: () => isWindow(owner),
      dispose: () => {
        destroyWindow(owner);
        cached = undefined;
      },
    };
  } catch (error) {
    cached = null;
    log.出事("Windows 剪贴板接口加载失败，vivo 截图复制不启用（桌宠、看板照常）", error, "win32");
  }
  return cached;
}
