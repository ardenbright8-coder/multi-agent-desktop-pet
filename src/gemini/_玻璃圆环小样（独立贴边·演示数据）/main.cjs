// 独立界面预览与实机小球：测试模式用演示数据，日常运行自动读取浏览器多Gmail账号真实Gemini额度。
const electron = require("electron");
const { app, BrowserWindow, ipcMain, screen, nativeTheme } = electron;
const { join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dockOrb, panelBounds, nearestSide, clamp, ORB_SIZE } = require("./geometry.cjs");
const { nextIndex } = require("./interaction.js");
const { createGlassWindow, keepLit, isMouseDown, isAnyBrowserWindowOpen, isGeminiAppOpen, isGeminiAppForeground, orbShape, panelShape } = require("./native-glass.cjs");
const test = process.env.GEMINI_GLASS_PREVIEW_TEST === "1";
const homeArg = process.argv.find(a => a.startsWith("--preview-home="));
const home = homeArg ? homeArg.slice("--preview-home=".length) : join(app.getPath("appData"), "GeminiGlassPreview");
app.setName("Gemini玻璃圆环 · 界面预览"); app.setPath("userData", home);
app.setAppUserModelId("local.gemini.glass.preview");
nativeTheme.themeSource = "dark"; // 只影响本预览进程，不改Windows主题。
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let orb, panel, shrinkTimer, shapeTimer, dragTimer, dragOffset, liveTimer, outsideTimer;
  let visible = false, expanded = false, count = 2, selected = test ? 1 : 0, side = "right", centerY, centerX, quitting = false, orbOver = false;
  let radiusNow = 13, animateShape = true, lastAutoActiveKey = "", manualSelectUntil = 0, wasMousePressed = false, sawDragDown = false;
  const preferences = join(home, "position.json");
  try {
    const p = JSON.parse(readFileSync(preferences, "utf8"));
    if (["left", "right", "top", "bottom"].includes(p.side)) side = p.side;
    if (Number.isFinite(p.centerY)) centerY = p.centerY;
    if (Number.isFinite(p.centerX)) centerX = p.centerX;
  } catch { /* 首次贴右侧，不读取其他应用数据。 */ }
  const palette = [
    { color: "#10B981", colorEnd: "#34D399", textColor: "#059669", name: "绿环" },
    { color: "#F43F5E", colorEnd: "#FB7185", textColor: "#E11D48", name: "红环" },
    { color: "#3B82F6", colorEnd: "#60A5FA", textColor: "#2563EB", name: "蓝环" }
  ];
  const samples = [
    { label: "1号", used: 9, reset: "14:30", weeklyUsed: 24, weeklyReset: "周五 08:00", color: "#3B82F6", colorEnd: "#60A5FA" },
    { label: "2号", used: 32, reset: "16:05", weeklyUsed: 45, weeklyReset: "周六 10:00", color: "#10B981", colorEnd: "#34D399" },
    { label: "3号", used: 63, reset: "18:20", weeklyUsed: 58, weeklyReset: "周日 09:00", color: "#F43F5E", colorEnd: "#FB7185" }
  ];
  function hasResetPassed(observedAt, resetRaw) {
    if (!Number.isFinite(observedAt) || observedAt <= 0) return false;
    if (Date.now() - observedAt >= 5 * 3600_000) return true;
    const m = String(resetRaw || "").match(/(\d{1,2}):(\d{2})/);
    if (!m) return false;
    const d = new Date(observedAt);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= observedAt) d.setDate(d.getDate() + 1);
    return Date.now() >= d.getTime();
  }
  function loadLiveAccounts() {
    const hubHome = process.env.AGENT_PET_HUB_HOME || "F:\\应用数据\\AgentPetHub";
    const file = join(hubHome, "gemini", "readings.json");
    let rows = [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) rows = parsed;
    } catch {}
    const browserOpen = isAnyBrowserWindowOpen();
    const list = [], seenIds = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const accId = String(r.accountId || i);
      if (seenIds.has(accId)) continue;
      seenIds.add(accId);
      const resetRaw = r.current?.reset?.raw || "--";
      const expired = hasResetPassed(Number(r.observedAt), resetRaw);
      const used = expired ? 0 : Math.max(0, Math.min(100, Math.round(Number(r.current?.used) || 0)));
      const weeklyUsed = Math.max(0, Math.min(100, Math.round(Number(r.weekly?.used) || 0)));
      const rawPlan = String(r.plan || "");
      const hasWeekly = Boolean(r.weekly && r.weekly.reset && r.weekly.reset.raw);
      const isUltra = /ULTRA/i.test(rawPlan);
      const isPro = /\b(PRO|PLUS|ADVANCED)\b/i.test(rawPlan) || (!rawPlan && hasWeekly);
      const isFree = /普通|FREE|标准/i.test(rawPlan) || (!rawPlan && !hasWeekly);
      const plan = isUltra ? "ULTRA · 5倍" : isPro ? "PRO" : isFree ? "普通" : "ULTRA · 5倍";
      const shortPlan = isUltra ? "Ultra 5倍" : isPro ? "Pro" : isFree ? "普通" : "Ultra 5倍";
      const label = r.accountTag ? (r.accountTag + " · " + shortPlan) : shortPlan;
      const ageMin = r.observedAt ? Math.max(0, Math.round((Date.now() - Number(r.observedAt)) / 60000)) : 0;
      const syncText = expired ? "5h窗口已重置" : (ageMin <= 1 ? "刚刚同步" : ageMin + "分钟前同步");
      const seenAt = Number(r.lastSeenAt || 0);
      const isClosed = !browserOpen || r.closed === true || !seenAt || (Date.now() - seenAt > 35_000);
      list.push({
        key: "gemini:" + (r.accountId || i),
        label,
        isUltra,
        isPro,
        isClosed,
        used,
        remaining: 100 - used,
        reset: resetRaw,
        weeklyUsed,
        weeklyReset: r.weekly?.reset?.raw || "--",
        plan: plan + "（已用" + used + "%）",
        statusText: syncText,
        activeAt: seenAt
      });
    }
    if (!list.length) {
      const empty = samples.slice(0, 1).map(a => ({ ...a, remaining: 100 - a.used, plan: "等待浏览器同步", statusText: "请打开Gemini网页" }));
      empty.allClosed = true;
      return empty;
    }
    const appOpen = isGeminiAppOpen();
    const appProKey = appOpen ? (list.find(a => a.isPro && a.used > 0) || list.find(a => a.isPro))?.key : null;
    let openList = list.filter(a => !a.isClosed || (appProKey && a.key === appProKey)).slice(0, 3);
    const allClosed = openList.length === 0;
    if (!openList.length) {
      let latest = list[0];
      for (const a of list) if (a.activeAt > latest.activeAt) latest = a;
      openList = [latest];
    }
    let otherColorIdx = 1;
    const mapped = openList.map(a => {
      const c = a.isUltra ? palette[0] : palette[(otherColorIdx++ === 1) ? 1 : 2];
      return { ...a, color: c.color, colorEnd: c.colorEnd, textColor: c.textColor };
    });
    mapped.allClosed = allClosed;
    return mapped;
  }
  const workArea = () => screen.getDisplayMatching(orb ? orb.getBounds() : screen.getPrimaryDisplay().workArea).workArea;
  const snapshot = () => {
    if (test) {
      return { preview: true, accounts: samples.slice(0, count).map(a => ({ ...a, remaining: 100 - a.used })),
        selected, visible, expanded, side, dragging: !!dragTimer, material: orb?.__glassNative ? "native-acrylic" : "translucent-fallback" };
    }
    const accounts = loadLiveAccounts();
    const allClosed = accounts.allClosed === true;
    if (Date.now() > manualSelectUntil && accounts.length > 1) {
      if (isGeminiAppForeground()) {
        const proIdx = accounts.findIndex(a => a.isPro);
        if (proIdx >= 0) selected = proIdx;
      } else {
        let bestIdx = 0, bestTime = -1;
        accounts.forEach((a, idx) => { if ((a.activeAt || 0) > bestTime) { bestTime = a.activeAt || 0; bestIdx = idx; } });
        const activeKey = accounts[bestIdx].key + ":" + bestTime;
        if (bestTime > 0 && activeKey !== lastAutoActiveKey) {
          lastAutoActiveKey = activeKey;
          selected = bestIdx;
        }
      }
    }
    selected = Math.max(0, Math.min(selected, accounts.length - 1));
    return { preview: false, allClosed, accounts, selected, visible, expanded, side, dragging: !!dragTimer,
      material: orb?.__glassNative ? "native-acrylic" : "translucent-fallback" };
  };
  function publish() {
    const snap = snapshot();
    if (!test && !homeArg && orb && !orb.isDestroyed()) {
      if (snap.allClosed) {
        if (orb.isVisible()) orb.hide();
        if (visible) { visible = false; clearInterval(outsideTimer); outsideTimer = null; panel?.hide(); }
      } else if (!orb.isVisible() && !orb.webContents.isLoadingMainFrame()) {
        orb.showInactive(); keepLit(orb);
      }
    }
    for (const w of [orb, panel]) if (w && !w.isDestroyed() && !w.webContents.isLoadingMainFrame()) w.webContents.send("glass-preview:snapshot", snap);
  }
  function setExpanded(value) {
    clearTimeout(shrinkTimer);
    if (expanded === value) return;
    expanded = value; clearInterval(shapeTimer);
    if (orb?.__glassNative) {
      if (test || !animateShape) { radiusNow = value ? 26 : 13; orbShape(orb, radiusNow); }
      else {
        let step = 0; const from = radiusNow, to = value ? 26 : 13;
        shapeTimer = setInterval(() => { step++; radiusNow = from + (to - from) * (step / 8); orbShape(orb, radiusNow); if (step >= 8) clearInterval(shapeTimer); }, 16);
      }
    }
    publish();
  }
  function savePosition() {
    try { mkdirSync(home, { recursive: true }); writeFileSync(preferences, JSON.stringify({ side, centerY, centerX })); }
    catch (error) { console.error("预览位置没能保存：" + error.message); }
  }
  function inBounds(pt, b) {
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  }
  function layoutPanel() {
    if (orb && panel) { panel.setBounds(panelBounds(workArea(), orb.getBounds()), false); panelShape(panel); }
  }
  function hidePanel() {
    visible = false; clearInterval(outsideTimer); outsideTimer = null; panel?.hide();
    if (panel && !panel.isDestroyed()) panel.setIgnoreMouseEvents(true, { forward: true });
    publish();
  }
  function showDetails() {
    if (!orb || !panel || dragTimer) return;
    visible = true; layoutPanel(); publish();
    if (!panel.webContents.isLoadingMainFrame()) { panel.showInactive(); keepLit(panel); }
    clearInterval(outsideTimer);
    if (!test) {
      wasMousePressed = isMouseDown().left || isMouseDown().right;
      outsideTimer = setInterval(() => {
        if (!visible || !panel || panel.isDestroyed() || !orb || orb.isDestroyed()) { clearInterval(outsideTimer); outsideTimer = null; return; }
        const m = isMouseDown(), nowPressed = m.left || m.right;
        if (nowPressed && !wasMousePressed) {
          const pt = screen.getCursorScreenPoint();
          if (!inBounds(pt, panel.getBounds()) && !inBounds(pt, orb.getBounds())) hidePanel();
        }
        wasMousePressed = nowPressed;
      }, 40);
    }
  }
  function setHover(w, active) {
    if (w === panel) {
      if (!visible) return;
      w.setIgnoreMouseEvents(!active, { forward: true }); return;
    }
    orbOver = active;
    w.setIgnoreMouseEvents(!(active || dragTimer), { forward: true });
    if (active) setExpanded(true);
    else if (!dragTimer) shrinkTimer = setTimeout(() => { if (!orbOver && !dragTimer) setExpanded(false); }, 180);
  }
  function dock(toSide = side, cy = centerY, persist = true, cx = centerX) {
    if (!orb) return;
    side = toSide; const bounds = dockOrb(workArea(), side, cy, cx);
    centerY = bounds.y + bounds.height / 2; centerX = bounds.x + bounds.width / 2;
    orb.setBounds(bounds, false); orbShape(orb, expanded ? 26 : 13); layoutPanel();
    if (persist) savePosition(); publish();
  }
  function stopDrag() {
    if (!dragTimer) return;
    clearInterval(dragTimer); dragTimer = null; dragOffset = null; sawDragDown = false;
    const b = orb.getBounds(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    centerX = cx; centerY = cy;
    dock(test ? nearestSide(workArea(), cx) : nearestSide(workArea(), cx, cy), cy, true, cx);
    const pt = screen.getCursorScreenPoint();
    orbOver = inBounds(pt, orb.getBounds());
    orb.setIgnoreMouseEvents(!orbOver, { forward: true });
    if (!orbOver) shrinkTimer = setTimeout(() => { if (!orbOver && !dragTimer) setExpanded(false); }, 180);
    publish();
  }
  function startDrag() {
    if (dragTimer) return;
    hidePanel(); setExpanded(true);
    const p = screen.getCursorScreenPoint(), b = orb.getBounds();
    dragOffset = { x: p.x - b.x, y: p.y - b.y }; orb.setIgnoreMouseEvents(false);
    sawDragDown = isMouseDown().left;
    dragTimer = setInterval(() => {
      if (!orb || orb.isDestroyed()) return;
      if (!test) {
        const down = isMouseDown().left;
        if (down) sawDragDown = true;
        else if (sawDragDown) { stopDrag(); return; }
      }
      const p = screen.getCursorScreenPoint(), area = screen.getDisplayNearestPoint(p).workArea;
      orb.setBounds({ x: Math.round(clamp(p.x - dragOffset.x, area.x, area.x + area.width - ORB_SIZE)),
        y: Math.round(clamp(p.y - dragOffset.y, area.y, area.y + area.height - ORB_SIZE)), width: ORB_SIZE, height: ORB_SIZE }, false);
    }, 16);
    publish();
  }
  function trusted(event) { const w = BrowserWindow.fromWebContents(event.sender); return w && (w === orb || w === panel) ? w : null; }
  function makeWindow(view) {
    const w = createGlassWindow(electron, { width: view === "orb" ? ORB_SIZE : 224, height: view === "orb" ? ORB_SIZE : 218,
      title: "Gemini玻璃圆环 · " + (view === "orb" ? "小球" : "详情") + "预览（演示数据）",
      icon: join(__dirname, "bubble.ico"), frame: false, backgroundColor: "#00000000",
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      focusable: false, show: false, hasShadow: false,
      webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: true, devTools: test } });
    w.setMenu(null); w.setAlwaysOnTop(true, "floating"); w.setIgnoreMouseEvents(true, { forward: true });
    w.webContents.on("will-navigate", e => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("did-finish-load", () => {
      publish();
      if (!test && (homeArg || !snapshot().allClosed) && (view === "orb" || visible)) { w.showInactive(); keepLit(w); }
    });
    w.on("closed", () => { if (!quitting) app.quit(); });
    void w.loadFile(join(__dirname, "index.html"), { query: { view } });
    return w;
  }
  ipcMain.handle("glass-preview:get", event => { if (!trusted(event)) throw new Error("不是本小样窗口"); return snapshot(); });
  ipcMain.on("glass-preview:hover", (event, active, reducedMotion) => { const w = trusted(event); if (w) { if (w === orb) animateShape = reducedMotion !== true; setHover(w, active === true); } });
  ipcMain.on("glass-preview:count", (event, value) => {
    if (!trusted(event) || ![1, 2, 3].includes(value)) return;
    count = value; selected = Math.min(selected, count - 1); publish();
  });
  ipcMain.on("glass-preview:select", (event, value) => {
    const total = test ? count : snapshot().accounts.length;
    if (trusted(event) && Number.isInteger(value) && value >= 0 && value < total) {
      if (!test) manualSelectUntil = Date.now() + 60000;
      selected = value; publish();
    }
  });
  ipcMain.on("glass-preview:cycle", (event, direction) => {
    if (trusted(event) !== orb || !["next", "previous"].includes(direction) || dragTimer) return;
    const total = test ? count : snapshot().accounts.length;
    if (!test) manualSelectUntil = Date.now() + 60000;
    selected = nextIndex(selected, direction, total); publish();
  });
  ipcMain.on("glass-preview:drag", (event, phase) => {
    if (trusted(event) !== orb) return;
    if (phase === "start") startDrag(); else if (phase === "end") stopDrag();
  });
  ipcMain.on("glass-preview:action", (event, action) => {
    if (!trusted(event)) return;
    if (action === "details") showDetails();
    else if (action === "close") hidePanel();
    else if (action === "left" || action === "right") dock(action);
    else if (action === "quit") app.quit();
  });
  app.on("second-instance", () => {
    if (orb && !orb.isDestroyed()) { orb.webContents.reloadIgnoringCache(); orb.showInactive(); keepLit(orb); }
    if (panel && !panel.isDestroyed()) panel.webContents.reloadIgnoringCache();
  });
  app.on("before-quit", () => {
    quitting = true; clearTimeout(shrinkTimer); clearInterval(shapeTimer); clearInterval(dragTimer); clearInterval(liveTimer); clearInterval(outsideTimer);
    if (orb && !orb.isDestroyed()) savePosition();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(() => {
    orb = makeWindow("orb"); panel = makeWindow("panel"); dock(side, centerY, false, centerX);
    if (!test) liveTimer = setInterval(publish, 1500);
    screen.on("display-metrics-changed", () => dock(side, centerY, false, centerX));
    screen.on("display-removed", () => dock(side, centerY, false, centerX));
  });
}
