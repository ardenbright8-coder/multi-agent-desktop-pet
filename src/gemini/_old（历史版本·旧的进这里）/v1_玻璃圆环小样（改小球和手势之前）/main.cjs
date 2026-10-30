// 独立界面小样：不 import 其他板块，不接真实账号，不改日常 dist / 系统自启。
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dockOrb, panelBounds, nearestSide, clamp, ORB_SIZE } = require("./geometry.cjs");
const test = process.env.GEMINI_GLASS_PREVIEW_TEST === "1";
const homeArg = process.argv.find(a => a.startsWith("--preview-home="));
const home = homeArg ? homeArg.slice("--preview-home=".length) : join(app.getPath("appData"), "GeminiGlassPreview");
app.setName("Gemini玻璃圆环 · 界面预览");
app.setPath("userData", home);
app.setAppUserModelId("local.gemini.glass.preview");
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let orb, panel, closeTimer, dragTimer, dragOffset, mode = "summary", visible = false, count = 2;
  let side = "right", centerY, over = new Set(), quitting = false;
  const preferenceFile = join(home, "position.json");
  try {
    const p = JSON.parse(readFileSync(preferenceFile, "utf8"));
    if (p.side === "left" || p.side === "right") side = p.side;
    if (Number.isFinite(p.centerY)) centerY = p.centerY;
  } catch { /* 首次预览直接贴右边 */ }
  const samples = [
    { label: "1号", used: 9, reset: "14:30", weeklyUsed: 24, weeklyReset: "周五 08:00", color: "#397ce8" },
    { label: "2号", used: 32, reset: "16:05", weeklyUsed: 45, weeklyReset: "周六 10:00", color: "#159e93" },
    { label: "3号", used: 63, reset: "18:20", weeklyUsed: 58, weeklyReset: "周日 09:00", color: "#9472d6" }
  ];
  const workArea = () => screen.getDisplayMatching(orb ? orb.getBounds() : screen.getPrimaryDisplay().workArea).workArea;
  const snapshot = () => ({ preview: true, accounts: samples.slice(0, count).map(a => ({ ...a, remaining: 100 - a.used })),
    mode, visible, side, dragging: !!dragTimer });
  function publish() {
    const data = snapshot();
    for (const w of [orb, panel]) if (w && !w.isDestroyed() && !w.webContents.isLoadingMainFrame()) w.webContents.send("glass-preview:snapshot", data);
  }
  function savePosition() {
    try { mkdirSync(home, { recursive: true }); writeFileSync(preferenceFile, JSON.stringify({ side, centerY })); }
    catch (error) { console.error("小样位置没能保存：" + error.message); }
  }
  function layoutPanel() { if (orb && panel) panel.setBounds(panelBounds(workArea(), orb.getBounds(), mode, count), false); }
  function hidePanel() {
    clearTimeout(closeTimer); visible = false; mode = "summary"; over.delete(panel?.id);
    panel?.hide(); if (panel && !panel.isDestroyed()) panel.setIgnoreMouseEvents(true, { forward: true });
    publish();
  }
  function showPanel(nextMode = mode) {
    if (!orb || !panel || dragTimer) return;
    clearTimeout(closeTimer); mode = nextMode; visible = true; layoutPanel(); publish();
    if (!panel.webContents.isLoadingMainFrame()) panel.showInactive();
  }
  function setHover(w, active) {
    if (w === panel && active && !visible) return;
    if (active) {
      over.add(w.id); w.setIgnoreMouseEvents(false);
      if (!dragTimer) showPanel();
    } else {
      over.delete(w.id); w.setIgnoreMouseEvents(true, { forward: true });
      clearTimeout(closeTimer);
      if (mode !== "details") closeTimer = setTimeout(() => { if (!over.size && !dragTimer) hidePanel(); }, 520);
    }
  }
  function dock(toSide = side, cy = centerY, persist = true) {
    if (!orb) return;
    const area = workArea(); side = toSide;
    const bounds = dockOrb(area, side, cy); centerY = bounds.y + bounds.height / 2;
    orb.setBounds(bounds, false); layoutPanel(); if (persist) savePosition(); publish();
  }
  function stopDrag() {
    if (!dragTimer) return;
    clearInterval(dragTimer); dragTimer = null; dragOffset = null;
    const area = workArea(), b = orb.getBounds();
    side = nearestSide(area, b.x + b.width / 2); centerY = b.y + b.height / 2;
    orb.webContents.send("glass-preview:drag-ended"); dock(); orb.setIgnoreMouseEvents(true, { forward: true });
  }
  function startDrag() {
    if (dragTimer) return;
    hidePanel(); over.clear();
    const p = screen.getCursorScreenPoint(), b = orb.getBounds();
    dragOffset = { x: p.x - b.x, y: p.y - b.y };
    orb.setIgnoreMouseEvents(false);
    dragTimer = setInterval(() => {
      if (!orb || orb.isDestroyed()) return stopDrag();
      const p = screen.getCursorScreenPoint(), area = screen.getDisplayNearestPoint(p).workArea;
      const next = { x: Math.round(clamp(p.x - dragOffset.x, area.x, area.x + area.width - ORB_SIZE)),
        y: Math.round(clamp(p.y - dragOffset.y, area.y, area.y + area.height - ORB_SIZE)), width: ORB_SIZE, height: ORB_SIZE };
      orb.setBounds(next, false); centerY = next.y + next.height / 2;
    }, 25);
    publish();
  }
  function trusted(event) {
    const w = BrowserWindow.fromWebContents(event.sender);
    return w && (w === orb || w === panel) ? w : null;
  }
  function makeWindow(view) {
    const w = new BrowserWindow({ width: view === "orb" ? ORB_SIZE : 346, height: view === "orb" ? ORB_SIZE : 330,
      title: "Gemini玻璃圆环 · " + (view === "orb" ? "小球" : "用量") + "预览（演示数据）",
      icon: join(__dirname, "bubble.ico"), frame: false, transparent: true, backgroundColor: "#00000000",
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      focusable: false, show: false, hasShadow: false, roundedCorners: true,
      webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: true, devTools: test } });
    w.setMenu(null); w.setAlwaysOnTop(true, "floating");
    w.setIgnoreMouseEvents(true, { forward: true });
    w.webContents.on("will-navigate", e => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("did-finish-load", () => {
      publish();
      if (!test && (view === "orb" || visible)) w.showInactive();
    });
    w.on("closed", () => { if (!quitting) app.quit(); });
    void w.loadFile(join(__dirname, "index.html"), { query: { view } });
    return w;
  }
  ipcMain.handle("glass-preview:get", event => { if (!trusted(event)) throw new Error("不是本小样窗口"); return snapshot(); });
  ipcMain.on("glass-preview:hover", (event, active) => { const w = trusted(event); if (w) setHover(w, active === true); });
  ipcMain.on("glass-preview:count", (event, value) => {
    if (!trusted(event) || ![1, 2, 3].includes(value)) return;
    count = value; layoutPanel(); publish();
  });
  ipcMain.on("glass-preview:drag", (event, phase) => {
    if (trusted(event) !== orb) return;
    if (phase === "start") startDrag(); else if (phase === "end") stopDrag();
  });
  ipcMain.on("glass-preview:action", (event, action) => {
    if (!trusted(event)) return;
    if (action === "details") showPanel("details");
    else if (action === "back") { mode = "summary"; layoutPanel(); publish(); }
    else if (action === "close") hidePanel();
    else if (action === "left" || action === "right") dock(action);
    else if (action === "quit") app.quit();
  });
  app.on("second-instance", () => { if (orb && !orb.isDestroyed()) orb.showInactive(); });
  app.on("before-quit", () => {
    quitting = true; clearTimeout(closeTimer); clearInterval(dragTimer);
    if (orb && !orb.isDestroyed()) savePosition();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(() => {
    orb = makeWindow("orb"); panel = makeWindow("panel"); dock(side, centerY, false);
    screen.on("display-metrics-changed", () => dock(side, centerY, false));
    screen.on("display-removed", () => dock(side, centerY, false));
  });
}
