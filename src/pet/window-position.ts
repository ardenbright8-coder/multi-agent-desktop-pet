export interface Point { x: number; y: number }
export interface Rectangle extends Point { width: number; height: number }

// 默认落脚点：靠右，竖直方向让幼苗停在屏幕高度约 2/3 处（用户 2026-08-12 指定，
// 原来是贴着底边，太靠下）。算完还是会被 clampWindowPosition 收进工作区。
export function defaultWindowPosition(workArea: Rectangle, windowSize: { width: number; height: number }): Point {
  const wanted = workArea.y + Math.round(workArea.height * 2 / 3 - windowSize.height / 2);
  const lowest = workArea.y + workArea.height - windowSize.height - 22;
  return {
    x: workArea.x + workArea.width - windowSize.width - 28,
    y: Math.max(workArea.y, Math.min(wanted, lowest)),
  };
}

export function clampWindowPosition(
  saved: Point,
  workAreas: Rectangle[],
  windowSize: { width: number; height: number },
  visibleBounds: Rectangle = { x: 0, y: 0, ...windowSize },
): Point {
  if (!workAreas.length) return saved;
  const windowBounds = {
    x: saved.x + visibleBounds.x,
    y: saved.y + visibleBounds.y,
    width: visibleBounds.width,
    height: visibleBounds.height,
  };
  const target = [...workAreas].sort((left, right) => {
    const overlap = intersectionArea(windowBounds, right) - intersectionArea(windowBounds, left);
    return overlap || distanceToRectangle(windowBounds, left) - distanceToRectangle(windowBounds, right);
  })[0];
  return {
    x: clamp(saved.x, target.x - visibleBounds.x, target.x + target.width - visibleBounds.x - visibleBounds.width),
    y: clamp(saved.y, target.y - visibleBounds.y, target.y + target.height - visibleBounds.y - visibleBounds.height),
  };
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function distanceToRectangle(point: Point, rectangle: Rectangle): number {
  const dx = Math.max(rectangle.x - point.x, 0, point.x - (rectangle.x + rectangle.width));
  const dy = Math.max(rectangle.y - point.y, 0, point.y - (rectangle.y + rectangle.height));
  return dx * dx + dy * dy;
}

function clamp(value: number, minimum: number, maximum: number): number {
  // 窗口比屏幕还大时 maximum 会小于 minimum，直接 min/max 会把窗口推到屏幕外
  // （2026-08-12 踩过：窗口膨胀到比屏幕高之后，被一路推出顶部，怎么拖都上不去）。
  // 这种情况下贴左上，至少让人看得见、够得着。
  if (maximum < minimum) return Math.round(minimum);
  return Math.round(Math.min(Math.max(value, minimum), maximum));
}
