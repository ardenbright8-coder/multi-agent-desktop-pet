// 看板字号（2026-09-24 用户拍板：字太小看不见，Ctrl 加减、Ctrl+滚轮能调，调完记住）：缩放档位纯函数。
// 存取 IO 和按键接线在 panel-window（zoom.json 原子写，只管看板窗口，不注册全局热键）。

export const DEFAULT_BOARD_ZOOM = 1;
export const MIN_BOARD_ZOOM = 0.5;
export const MAX_BOARD_ZOOM = 2;
/** 一档 10%，按一下 / 滚一格走一档。 */
export const BOARD_ZOOM_STEP = 0.1;

/** 夹到 50%–200%，按 10% 取整（防浮点累加出 1.0000001）；非数字回落默认。 */
export function clampZoom(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BOARD_ZOOM;
  const snapped = Math.round(value * 10) / 10;
  return Math.min(MAX_BOARD_ZOOM, Math.max(MIN_BOARD_ZOOM, snapped));
}

/** 放大 / 缩小一档，到边就停在边上。 */
export function stepZoom(current: number, direction: "in" | "out"): number {
  return clampZoom(clampZoom(current) + (direction === "in" ? BOARD_ZOOM_STEP : -BOARD_ZOOM_STEP));
}

/** 解析 zoom.json 文本：zoom 必须是范围内的有限数字，否则回落默认（坏档不炸）。 */
export function parseZoom(text: string): number {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_BOARD_ZOOM;
    const zoom = (parsed as Record<string, unknown>).zoom;
    if (typeof zoom !== "number" || !Number.isFinite(zoom)) return DEFAULT_BOARD_ZOOM;
    if (zoom < MIN_BOARD_ZOOM || zoom > MAX_BOARD_ZOOM) return DEFAULT_BOARD_ZOOM;
    return clampZoom(zoom);
  } catch {
    return DEFAULT_BOARD_ZOOM;
  }
}

/** 键盘上哪一下算调字号。Ctrl+等号（不用按 Shift）/ 小键盘加号 = 放大，Ctrl+减号 / 小键盘减号 = 缩小，Ctrl+0 = 回原样。
 *  带 Alt 的不认（Ctrl+Alt 组合常被输入法、截图工具占用）。 */
export function zoomActionForKey(input: { key: string; code?: string; control: boolean; meta?: boolean; alt?: boolean }):
  "in" | "out" | "reset" | null {
  if (!(input.control || input.meta) || input.alt) return null;
  const code = input.code ?? "";
  if (input.key === "=" || input.key === "+" || code === "NumpadAdd") return "in";
  if (input.key === "-" || input.key === "_" || code === "NumpadSubtract") return "out";
  if (input.key === "0" || code === "Numpad0") return "reset";
  return null;
}
