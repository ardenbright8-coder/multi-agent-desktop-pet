export interface Point { x: number; y: number }
export interface Rectangle extends Point { width: number; height: number }

export function defaultWindowPosition(workArea: Rectangle, windowSize: { width: number; height: number }): Point {
  return {
    x: workArea.x + workArea.width - windowSize.width - 28,
    y: workArea.y + workArea.height - windowSize.height - 22,
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
  return Math.round(Math.min(Math.max(value, minimum), maximum));
}
