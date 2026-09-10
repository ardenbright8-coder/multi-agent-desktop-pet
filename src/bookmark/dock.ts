// 看板贴屏几何与 Win32 沉底常量：纯函数零依赖，方便单测。
// 「总在其他窗口之下」的实测语义（2026-09-10 用户拍板）：压在桌面之上、被任何别的窗口盖住，
// 绝不挡人；用户正在面板里交互（聚焦）期间不压底，失焦才压。

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 存档的看板窗口尺寸（宽高，逻辑像素；位置不存——永远贴右缘由几何函数算）。 */
export interface SavedWindowSize {
  width: number;
  height: number;
}

/** 解析 window-bounds.json 的文本：宽高都得是正数，垃圾数据一律 null（坏档不炸，照 store 先例）。 */
export function parseSavedWindowSize(text: string): SavedWindowSize | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const map = parsed as Record<string, unknown>;
    const width = map.width;
    const height = map.height;
    if (typeof width !== "number" || typeof height !== "number") return null;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}

/** 贴主屏右缘：有存档尺寸用存档（宽夹在 [320, 屏宽]、高夹在 [200, 屏高]，换屏不炸），
 * 没传就用老规则（宽 = 工作区宽 ÷ 3，至少 320，防窄屏挤死），高 = 工作区全高（顶到底）。 */
export function computeDockedBounds(workArea: Rect, savedSize?: SavedWindowSize): Rect {
  const width = clamp(savedSize ? savedSize.width : Math.round(workArea.width / 3), 320, workArea.width);
  const height = clamp(savedSize ? savedSize.height : workArea.height, 200, workArea.height);
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Win32：HWND_BOTTOM = 压到 Z 序最底；SWP 组合 = 不动位置尺寸、不抢激活。 */
export const HWND_BOTTOM = 1;
export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SINK_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;
