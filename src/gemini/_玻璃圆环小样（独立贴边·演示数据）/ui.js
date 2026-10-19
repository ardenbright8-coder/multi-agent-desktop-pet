// 展示层只消费快照。真实采集、主宠位置、其他板块均不在这里。
(() => {
  "use strict";
  const bridge = window.glassPreview;
  const view = new URLSearchParams(location.search).get("view") === "panel" ? "panel" : "orb";
  document.body.dataset.view = view;
  const $ = id => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  let state, selected = "", hovered = false, pointer = null, dragging = false;
  function setText(id, value) { $(id).textContent = String(value); }
  function rings(svg, accounts, large) {
    svg.replaceChildren();
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i], radius = large ? 27 - i * 7 : 28 - i * 5.4;
      for (const filled of [false, true]) {
        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("cx", "32"); circle.setAttribute("cy", "32"); circle.setAttribute("r", String(radius));
        circle.setAttribute("pathLength", "100");
        circle.classList.add(filled ? "ring-fill" : "ring-track");
        if (filled) {
          circle.setAttribute("stroke", account.color);
          circle.setAttribute("stroke-dasharray", account.remaining + " 100");
          circle.setAttribute("data-remaining", String(account.remaining));
          if (account.remaining === 0) circle.setAttribute("visibility", "hidden");
        }
        svg.append(circle);
      }
    }
  }
  function render(data) {
    const enteringDetails = data.mode === "details" && state?.mode !== "details";
    state = data;
    const worst = data.accounts.reduce((a, b) => a.remaining <= b.remaining ? a : b);
    if (enteringDetails || !data.accounts.some(a => a.label === selected)) selected = worst.label;
    document.body.dataset.mode = data.mode;
    document.body.dataset.expanded = String(data.visible);
    $("orbShell").classList.toggle("is-open", data.visible);
    $("orbShell").classList.toggle("is-dragging", data.dragging);
    setText("orbNumber", worst.remaining);
    $("orbValue").classList.toggle("three-digits", worst.remaining >= 100);
    $("orb").setAttribute("aria-label", "演示数据，5小时最低剩余" + worst.remaining + "%，" + worst.label + "。悬停展开，右键详情，拖动贴边");
    rings($("orbRings"), data.accounts, false);
    if (view !== "panel") return;
    const details = data.mode === "details";
    $("summary").hidden = details; $("details").hidden = !details;
    $("detailsButton").hidden = details; $("detailFooter").hidden = !details;
    setText("headerSubtitle", details ? "用量详情" : "5 小时额度");
    setText("heroNumber", worst.remaining); setText("heroCaption", "当前最低余量 · " + worst.label);
    rings($("heroRings"), data.accounts, true);
    $("accountList").replaceChildren(...data.accounts.map(account => {
      const row = document.createElement("div"); row.className = "account-row";
      const meta = document.createElement("div"); meta.className = "account-meta";
      const dot = document.createElement("i"); dot.className = "account-dot"; dot.style.background = account.color;
      const name = document.createElement("span"); name.className = "account-name"; name.textContent = account.label;
      const reset = document.createElement("span"); reset.className = "account-reset"; reset.textContent = account.reset + " 重置";
      meta.append(dot, name, reset);
      const value = document.createElement("span"); value.className = "account-remaining"; value.textContent = String(account.remaining);
      const suffix = document.createElement("small"); suffix.textContent = "%"; value.append(suffix);
      row.append(meta, value); return row;
    }));
    $("accountTabs").replaceChildren(...data.accounts.map(account => {
      const button = document.createElement("button");
      button.className = "account-tab"; button.textContent = account.label;
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(account.label === selected));
      button.style.setProperty("--account-color", account.color); button.dataset.account = account.label;
      return button;
    }));
    const account = data.accounts.find(a => a.label === selected) || worst;
    setText("detailNumber", account.remaining); setText("detailReset", account.reset);
    setText("detailWeekly", (100 - account.weeklyUsed) + "%"); setText("detailWeeklyReset", account.weeklyReset);
    for (const button of document.querySelectorAll("[data-count]")) button.setAttribute("aria-pressed", String(Number(button.dataset.count) === data.accounts.length));
    for (const button of document.querySelectorAll(".dock-controls [data-action]")) button.setAttribute("aria-pressed", String(button.dataset.action === data.side));
  }
  function hover(value) { if (hovered !== value) { hovered = value; bridge.hover(value); } }
  document.addEventListener("mousemove", event => hover(!!event.target.closest("[data-hit]")));
  document.addEventListener("mouseleave", () => hover(false));
  document.addEventListener("click", event => {
    if (dragging) return;
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.action) bridge.action(button.dataset.action);
    else if (button.dataset.count) bridge.count(Number(button.dataset.count));
    else if (button.dataset.account) { selected = button.dataset.account; render(state); }
  });
  document.addEventListener("contextmenu", event => { event.preventDefault(); bridge.action("details"); });
  $("orb").addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    $("orb").setPointerCapture(event.pointerId);
  });
  $("orb").addEventListener("pointermove", event => {
    if (!pointer) return;
    if (!dragging && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) {
      dragging = true; bridge.drag("start");
    }
  });
  function endDrag() {
    if (dragging) bridge.drag("end");
    pointer = null;
    setTimeout(() => { dragging = false; }, 0);
  }
  $("orb").addEventListener("pointerup", endDrag);
  $("orb").addEventListener("pointercancel", endDrag);
  $("orb").addEventListener("lostpointercapture", () => { if (pointer) endDrag(); });
  window.addEventListener("blur", () => { if (pointer) endDrag(); });

  // 固定几何位移图：只在尺寸变化时生成，清晰文字独立盖在折光层之上。
  function displacement(element, imageId, radius) {
    const width = Math.max(1, Math.round(element.clientWidth)), height = Math.max(1, Math.round(element.clientHeight));
    const map = document.createElement("canvas"); map.width = width; map.height = height;
    const ctx = map.getContext("2d"), data = ctx.createImageData(width, height);
    const r = Math.min(radius, width / 2, height / 2), cx = width / 2, cy = height / 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const px = x - cx, py = y - cy;
      const qx = Math.abs(px) - (cx - r), qy = Math.abs(py) - (cy - r);
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0), length = Math.hypot(ax, ay);
      const distance = length + Math.min(Math.max(qx, qy), 0) - r;
      const band = Math.max(0, 1 - Math.abs(distance) / 10);
      let nx, ny;
      if (length > .001) { nx = ax / length * Math.sign(px); ny = ay / length * Math.sign(py); }
      else if (qx > qy) { nx = Math.sign(px); ny = 0; } else { nx = 0; ny = Math.sign(py); }
      const index = (y * width + x) * 4;
      data.data[index] = 128 + nx * band * 65; data.data[index + 1] = 128 + ny * band * 65;
      data.data[index + 2] = 128; data.data[index + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    const image = $(imageId); image.setAttribute("width", String(width)); image.setAttribute("height", String(height));
    image.setAttribute("href", map.toDataURL("image/png"));
  }
  const element = view === "orb" ? $("orb") : $("panel");
  // 外部CSS里的裸#引用会按CSS文件解析；使用当前文档的完整URL，保留安全检查。
  const filterUrl = location.href.split("#")[0] + (view === "orb" ? "#orb-glass" : "#panel-glass");
  const refract = document.querySelector(view === "orb" ? ".orb-refract" : ".panel-refract");
  const filter = "blur(" + (view === "orb" ? 5 : 9) + 'px) url("' + filterUrl + '") saturate(1.18)';
  if (CSS.supports("backdrop-filter", filter)) refract.style.backdropFilter = filter;
  new ResizeObserver(() => displacement(element, view === "orb" ? "orb-map" : "panel-map", view === "orb" ? 25 : 26)).observe(element);
  bridge.onSnapshot(render);
  bridge.get().then(render).catch(error => { console.error("小样快照没读到", error); });
})();
