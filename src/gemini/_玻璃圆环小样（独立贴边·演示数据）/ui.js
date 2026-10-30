// 本块只消费快照；材质、手势、窗口几何各自隔离，不接触取数和主宠。
(() => {
  "use strict";
  const bridge = window.glassPreview, $ = id => document.getElementById(id), NS = "http://www.w3.org/2000/svg";
  const view = new URLSearchParams(location.search).get("view") === "panel" ? "panel" : "orb";
  document.body.dataset.view = view;
  let state, hovered = false, ringSignature = "";
  function text(id, value) { $(id).textContent = String(value); }
  function glow(hex) { const n = parseInt(hex.slice(1), 16); return "drop-shadow(0 0 5px rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + ",0.65))"; }
  function makeRings(accounts) {
    const svg = $("orbRings"), defs = document.createElementNS(NS, "defs"); svg.replaceChildren(defs);
    accounts.forEach((account, i) => {
      const gradient = document.createElementNS(NS, "linearGradient");
      gradient.id = "quota-progress-" + i; gradient.setAttribute("x1", "0%"); gradient.setAttribute("y1", "0%");
      gradient.setAttribute("x2", "100%"); gradient.setAttribute("y2", "100%");
      [account.color, account.colorEnd].forEach((color, j) => {
        const stop = document.createElementNS(NS, "stop"); stop.setAttribute("offset", j ? "100%" : "0%"); stop.setAttribute("stop-color", color); gradient.append(stop);
      });
      defs.append(gradient);
      for (const fill of [false, true]) {
        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("cx", "32"); circle.setAttribute("cy", "32"); circle.setAttribute("r", String(accounts.length === 3 ? 28.8 - i * 4.2 : 28.2 - i * 5.6));
        circle.setAttribute("pathLength", "100"); circle.classList.add(fill ? "ring-fill" : "ring-track");
        circle.dataset.index = String(i);
        circle.setAttribute("stroke", fill ? "url(#quota-progress-" + i + ")" : account.color);
        if (fill) {
          circle.setAttribute("stroke-dasharray", account.remaining + " 100"); circle.setAttribute("stroke-linecap", "round");
          if (account.remaining === 0) circle.setAttribute("visibility", "hidden");
        } else circle.setAttribute("opacity", "0.14");
        svg.append(circle);
      }
    });
  }
  function render(data) {
    state = data;
    const current = data.accounts[data.selected];
    document.body.dataset.expanded = String(data.expanded); document.body.dataset.visible = String(data.visible);
    document.body.dataset.account = String(data.selected); document.body.dataset.material = data.material;
    document.body.dataset.count = String(data.accounts.length); document.body.dataset.preview = String(!!data.preview);
    $("orbShell").classList.toggle("is-expanded", data.expanded); $("orbShell").classList.toggle("is-dragging", data.dragging);
    text("orbNumber", current.remaining); $("orbValue").classList.toggle("three-digits", current.remaining === 100);
    const smallEl = $("orbValue").querySelector("small");
    if (!data.preview) {
      const tc = current.textColor || current.color || "#16324F";
      $("orbValue").style.color = tc;
      if (smallEl) { smallEl.style.color = tc; smallEl.style.opacity = "0.78"; }
    } else {
      $("orbValue").style.color = "";
      if (smallEl) { smallEl.style.color = ""; smallEl.style.opacity = ""; }
    }
    $("orb").setAttribute("aria-label", current.label + "，5小时剩余" + current.remaining + "%。演示数据，左右划切账号，按住半秒拖动，右键详情");
    const signature = data.accounts.map(a => a.color + ":" + a.colorEnd).join("|");
    if (signature !== ringSignature) { ringSignature = signature; makeRings(data.accounts); }
    for (const circle of document.querySelectorAll(".ring-fill")) {
      const i = Number(circle.dataset.index), active = i === data.selected, acc = data.accounts[i];
      if (acc) {
        circle.setAttribute("stroke-dasharray", acc.remaining + " 100");
        if (acc.remaining === 0) circle.setAttribute("visibility", "hidden");
        else circle.removeAttribute("visibility");
      }
      circle.classList.toggle("is-selected", active); circle.style.filter = active ? glow(data.accounts[i].color) : "none";
    }
    if (view !== "panel") return;
    text("accountName", current.label); $("accountDot").style.background = current.color; $("accountDot").style.color = current.color;
    text("detailNumber", current.remaining); text("detailReset", current.reset);
    const impEl = $("detailNumber")?.closest(".important");
    if (impEl) impEl.style.color = !data.preview ? (current.textColor || current.color || "#16324F") : "";
    text("detailWeekly", (100 - current.weeklyUsed) + "%"); text("detailWeeklyReset", current.weeklyReset);
    const planEl = document.querySelector(".not-connected");
    if (planEl) {
      planEl.textContent = current.plan || "尚未接入";
      planEl.style.color = current.plan ? (data.preview ? "#F8FAFC" : "#16324F") : "";
      planEl.style.fontWeight = current.plan ? "600" : "";
    }
    const demoLabel = document.querySelector(".demo-label"), demoCount = document.querySelector(".demo-count"), exitBtn = document.querySelector(".exit-button");
    if (demoLabel) demoLabel.textContent = data.preview ? "演示数据" : (current.statusText || "实时监控");
    if (demoCount) demoCount.style.display = data.preview ? "" : "none";
    if (exitBtn) exitBtn.style.display = data.preview ? "" : "none";
    $("accountTabs").replaceChildren(...data.accounts.map((account, i) => {
      const button = document.createElement("button"); button.className = "account-tab"; button.textContent = String(i + 1);
      button.dataset.index = String(i); button.setAttribute("role", "tab"); button.setAttribute("aria-label", account.label);
      button.setAttribute("aria-selected", String(i === data.selected)); button.style.setProperty("--account-color", account.color); return button;
    }));
    for (const button of document.querySelectorAll("[data-count]")) button.setAttribute("aria-pressed", String(Number(button.dataset.count) === data.accounts.length));
  }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function hover(active) { if (hovered !== active) { hovered = active; bridge.hover(active, reducedMotion.matches); } }
  reducedMotion.addEventListener("change", () => bridge.hover(hovered, reducedMotion.matches));
  document.addEventListener("mousemove", event => hover(!!event.target.closest("[data-hit]")));
  document.addEventListener("mouseleave", () => hover(false));
  document.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.action) bridge.action(button.dataset.action);
    else if (button.dataset.count) bridge.count(Number(button.dataset.count));
    else if ("index" in button.dataset) bridge.select(Number(button.dataset.index));
  });
  document.addEventListener("contextmenu", event => { event.preventDefault(); bridge.action("details"); });
  $("orb").addEventListener("wheel", event => {
    event.preventDefault();
    bridge.cycle(event.deltaY > 0 ? "next" : "previous");
  }, { passive: false });
  let pointer = null, holdTimer;
  const gesture = window.QuotaGesture;
  $("orb").addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const immediateDrag = state && !state.preview;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, held: immediateDrag, movedEarly: false, dragging: false };
    $("orb").setPointerCapture(event.pointerId); $("orbShell").classList.add("is-pressed");
    if (immediateDrag) $("orbShell").classList.add("is-armed");
    $("orbValue").style.transition = "none";
    if (!immediateDrag) {
      holdTimer = setTimeout(() => {
        if (pointer && !pointer.movedEarly) { pointer.held = true; $("orbShell").classList.add("is-armed"); }
      }, gesture.HOLD_MS);
    }
  });
  $("orb").addEventListener("pointermove", event => {
    if (!pointer) return;
    pointer.dx = event.clientX - pointer.x; pointer.dy = event.clientY - pointer.y;
    if (!pointer.held && Math.hypot(pointer.dx, pointer.dy) > gesture.DRAG_SLOP) {
      pointer.movedEarly = true; clearTimeout(holdTimer);
    }
    if (!pointer.dragging && gesture.movement(pointer.dx, pointer.dy, pointer.held) === "drag") {
      pointer.dragging = true; bridge.drag("start");
    }
    if (!pointer.dragging && pointer.movedEarly) $("orbValue").style.transform = "translateX(" + Math.max(-4, Math.min(4, pointer.dx * .15)) + "px)";
  });
  function finishGesture(event, cancelled = false) {
    if (!pointer) return;
    const p = pointer; pointer = null; clearTimeout(holdTimer);
    $("orbShell").classList.remove("is-pressed", "is-armed");
    $("orbValue").style.transition = "transform 120ms ease-out"; $("orbValue").style.transform = "";
    if (p.dragging) bridge.drag("end");
    else if (!cancelled) {
      if (state && !state.preview && Math.hypot(p.dx, p.dy) <= gesture.DRAG_SLOP) {
        bridge.action(state.visible ? "close" : "details");
      } else {
        const result = gesture.movement(p.dx, p.dy, false);
        if (result === "next" || result === "previous") bridge.cycle(result);
      }
    }
    try { if ($("orb").hasPointerCapture(p.id)) $("orb").releasePointerCapture(p.id); } catch { /* 浏览器已释放 */ }
    if (event && Number.isFinite(event.clientX)) hover(!!document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-hit]"));
  }
  $("orb").addEventListener("pointerup", event => finishGesture(event));
  $("orb").addEventListener("pointercancel", event => finishGesture(event, true));
  $("orb").addEventListener("lostpointercapture", event => finishGesture(event, true));
  window.addEventListener("blur", () => finishGesture(null, true));
  bridge.onSnapshot(render); bridge.get().then(render).catch(error => console.error("预览快照未读取", error));
})();
