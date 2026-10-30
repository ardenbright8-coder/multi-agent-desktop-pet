// 只算本小样的窗口几何；坐标一律是 Electron 工作区坐标，不碰主宠。
const ORB_SIZE = 66, PANEL_WIDTH = 346, GAP = 7, MARGIN = 5;
function clamp(v, a, b) { return Math.max(a, Math.min(v, Math.max(a, b))); }
function dockOrb(area, side = "right", centerY = area.y + area.height * 0.62) {
  return { x: Math.round(side === "left" ? area.x + MARGIN : area.x + area.width - ORB_SIZE - MARGIN),
    y: Math.round(clamp(centerY - ORB_SIZE / 2, area.y + MARGIN, area.y + area.height - ORB_SIZE - MARGIN)),
    width: ORB_SIZE, height: ORB_SIZE };
}
function nearestSide(area, centerX) { return centerX < area.x + area.width / 2 ? "left" : "right"; }
function panelBounds(area, orb, mode, count) {
  const width = Math.min(PANEL_WIDTH, area.width - MARGIN * 2);
  const height = Math.min(mode === "details" ? 484 : 234 + count * 47, area.height - MARGIN * 2);
  const side = nearestSide(area, orb.x + orb.width / 2);
  let x = side === "right" ? orb.x - width - GAP : orb.x + orb.width + GAP;
  x = clamp(x, area.x + MARGIN, area.x + area.width - width - MARGIN);
  return { x: Math.round(x), y: Math.round(clamp(orb.y - 12, area.y + MARGIN, area.y + area.height - height - MARGIN)),
    width: Math.round(width), height: Math.round(height) };
}
module.exports = { ORB_SIZE, PANEL_WIDTH, dockOrb, panelBounds, nearestSide, clamp };
