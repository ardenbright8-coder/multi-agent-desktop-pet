// 看板外观设置（2026-09-10 用户拍板：毛玻璃太实要能自己调）：透明度解析/夹取纯函数。
// 存取 IO 在 panel-window（appearance.json 原子写），渲染层只管 CSS 变量实时预览。

/** 默认透明度：比改版初版（0.72）明显淡一点（用户原话：太实了，稍微透一点）。 */
export const DEFAULT_BOARD_OPACITY = 0.6;

export const MIN_BOARD_OPACITY = 0.3;
export const MAX_BOARD_OPACITY = 0.95;

/** 解析 appearance.json 文本：opacity 必须是有限数字且在范围内，否则回落默认（坏档不炸）。 */
export function parseAppearance(text: string): number {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_BOARD_OPACITY;
    const opacity = (parsed as Record<string, unknown>).opacity;
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) return DEFAULT_BOARD_OPACITY;
    if (opacity < MIN_BOARD_OPACITY || opacity > MAX_BOARD_OPACITY) return DEFAULT_BOARD_OPACITY;
    return opacity;
  } catch {
    return DEFAULT_BOARD_OPACITY;
  }
}

/** 夹取到合法范围；非数字回落默认（UI 滑条来的值也过这道闸）。 */
export function clampOpacity(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BOARD_OPACITY;
  return Math.min(MAX_BOARD_OPACITY, Math.max(MIN_BOARD_OPACITY, value));
}
