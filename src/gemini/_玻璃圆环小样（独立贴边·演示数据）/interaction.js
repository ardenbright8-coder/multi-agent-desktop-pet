// 浏览器/Node共用的纯判断；不碰鼠标或窗口。
(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuotaGesture = factory();
})(globalThis, function() {
  const HOLD_MS = 500, DRAG_SLOP = 5, SWIPE_SLOP = 12;
  function nextIndex(index, direction, count) {
    if (!Number.isInteger(count) || count < 1) return 0;
    return ((index + (direction === "previous" ? -1 : 1)) % count + count) % count;
  }
  function movement(dx, dy, held) {
    if (held && Math.hypot(dx, dy) > DRAG_SLOP) return "drag";
    if (!held && Math.abs(dx) >= SWIPE_SLOP && Math.abs(dx) > Math.abs(dy) * 1.3) return dx < 0 ? "next" : "previous";
    return "none";
  }
  return { HOLD_MS, DRAG_SLOP, SWIPE_SLOP, nextIndex, movement };
});
