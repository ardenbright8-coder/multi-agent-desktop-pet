// 只算本块窗口；固定球心，放大时不挪位置，坐标均为Electron工作区坐标。
const ORB_SIZE = 66, PANEL_WIDTH = 224, PANEL_HEIGHT = 218, GAP = 6, MARGIN = 5;
function clamp(v, a, b) { return Math.max(a, Math.min(v, Math.max(a, b))); }
function dockOrb(area, side = "right", centerY = area.y + area.height * 0.62, centerX = area.x + area.width * 0.5) {
  if (side === "top" || side === "bottom") {
    return { x: Math.round(clamp(centerX - ORB_SIZE / 2, area.x + MARGIN, area.x + area.width - ORB_SIZE - MARGIN)),
      y: Math.round(side === "top" ? area.y + MARGIN : area.y + area.height - ORB_SIZE - MARGIN),
      width: ORB_SIZE, height: ORB_SIZE };
  }
  return { x: Math.round(side === "left" ? area.x + MARGIN : area.x + area.width - ORB_SIZE - MARGIN),
    y: Math.round(clamp(centerY - ORB_SIZE / 2, area.y + MARGIN, area.y + area.height - ORB_SIZE - MARGIN)),
    width: ORB_SIZE, height: ORB_SIZE };
}
function nearestSide(area, centerX, centerY) {
  if (!Number.isFinite(centerY)) return centerX < area.x + area.width / 2 ? "left" : "right";
  const dLeft = Math.abs(centerX - area.x), dRight = Math.abs(area.x + area.width - centerX);
  const dTop = Math.abs(centerY - area.y), dBottom = Math.abs(area.y + area.height - centerY);
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dTop) return "top";
  if (min === dBottom) return "bottom";
  return dLeft <= dRight ? "left" : "right";
}
function panelBounds(area, orb) {
  const width = Math.min(PANEL_WIDTH, area.width - MARGIN * 2), height = Math.min(PANEL_HEIGHT, area.height - MARGIN * 2);
  const side = nearestSide(area, orb.x + orb.width / 2);
  return { x: Math.round(clamp(side === "right" ? orb.x - width - GAP : orb.x + orb.width + GAP, area.x + MARGIN, area.x + area.width - width - MARGIN)),
    y: Math.round(clamp(orb.y - 8, area.y + MARGIN, area.y + area.height - height - MARGIN)), width, height };
}
module.exports = { ORB_SIZE, PANEL_WIDTH, PANEL_HEIGHT, dockOrb, panelBounds, nearestSide, clamp };
