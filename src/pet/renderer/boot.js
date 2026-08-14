// 启动：绑事件、拉第一份快照、开定时器。
// 必须最后一个加载——上面几份声明的东西这儿全要用到。

// 界面塌了要留痕：以前渲染层报错谁也看不见，只能干瞪眼。
window.addEventListener("error", (event) => {
  window.agentPet?.reportError?.({
    message: event.message || String(event.error || "未知错误"),
    where: event.filename ? `${event.filename}:${event.lineno}` : "renderer",
    stack: event.error && event.error.stack ? String(event.error.stack) : undefined,
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  window.agentPet?.reportError?.({
    message: `未处理的 Promise 失败：${reason && reason.message ? reason.message : String(reason)}`,
    where: "renderer/promise",
    stack: reason && reason.stack ? String(reason.stack) : undefined,
  });
});

// 鼠标一动就重新判断底下有没有能点的东西（拖动中不用管，窗口位置由主进程读系统光标算）。
// 窗口平时是穿透的，靠 setIgnoreMouseEvents 的 forward 把 mousemove 转发进来，所以这条一直收得到。
document.addEventListener("mousemove", (event) => {
  if (petPickedUp) return;
  syncHitTest(event);
});
// 拖动窗口：按住窗口主体（画框）拖动 → 移动整个窗口（2026-08-14 桌面幼苗移除后）
const sceneFrame = document.querySelector(".scene-frame");
sceneFrame.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  // 座位/状态框/菜单这些可点元素上不启动拖动（点了该点的事）；画框本体可拖
  if (event.target instanceof Element
    && (event.target.closest(".seat-filled") || event.target.closest("#status-note") || event.target.closest("#pet-menu"))) return;
  beginPetDrag(event, sceneFrame);
});
sceneFrame.addEventListener("dragstart", (event) => event.preventDefault());
// 右键窗口任意处弹出功能菜单（2026-08-14：托盘功能集成到窗口右键）
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showPetMenu(event.clientX, event.clientY);
});
// ===== 右键功能菜单（2026-08-14 新增：托盘功能集成到窗口）=====
const petMenu = document.querySelector("#pet-menu");
function showPetMenu(clientX, clientY) {
  petMenu.hidden = false;
  const x = Math.min(Math.max(0, clientX), window.innerWidth - petMenu.offsetWidth - 4);
  const y = Math.min(Math.max(0, clientY), window.innerHeight - petMenu.offsetHeight - 4);
  petMenu.style.left = `${x}px`;
  petMenu.style.top = `${y}px`;
}
petMenu.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-menu]") : null;
  if (!button) return;
  const action = button.dataset.menu;
  petMenu.hidden = true;
  if (action === "drawer") openDrawer();
  else if (action === "settings") openSettings();
  else if (action === "hide") window.agentPet.hideWindow();
  else if (action === "simulate") window.agentPet.simulate();
  else if (action === "logs") window.agentPet.openLogs();
  else if (action === "quit") window.agentPet.quitApp();
});
// 点菜单外面收起；Esc 收起
document.addEventListener("pointerdown", (event) => {
  if (petMenu.hidden) return;
  if (event.target instanceof Element && petMenu.contains(event.target)) return;
  petMenu.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") petMenu.hidden = true;
});
// 滚轮缩放也一并挡掉，跟 Ctrl +/- 一个道理
 document.addEventListener("wheel", (event) => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });
document.addEventListener("pointerup", endPetDrag);
document.addEventListener("mouseup", endPetDrag);
document.addEventListener("pointercancel", endPetDrag);
window.addEventListener("blur", () => endPetDrag());
document.querySelector("#status-note").addEventListener("click", toggleDrawer);
// 点座位直接切到那个 Agent 终端窗口（每个有人坐的座位 = 一个开着的终端会话，v0.1.23）
document.querySelector("#agent-seats").addEventListener("click", (event) => {
  const seat = event.target instanceof Element ? event.target.closest(".seat-filled") : null;
  if (!seat) return;
  window.agentPet.focusAgent({
    agent: seat.dataset.agent,
    project: seat.dataset.project || undefined,
    originPid: Number(seat.dataset.originPid) || undefined,
  });
});
// 小人表情图按降级链加载（用户 2026-08-14 定）：
//   <agent>-<状态>.png → <状态>.png（通用图）→ <agent>.png → 隐藏（椅子还在，不崩）。
// error 事件不冒泡，用 capture 阶段兜住所有 img。
document.querySelector("#agent-seats").addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const step = Number(img.dataset.step || 0);
    const agent = img.dataset.agent || "";
    const expr = img.dataset.expr || "";
    if (step === 0 && expr) {
      img.dataset.step = "1";
      img.src = `assets/avatars/${encodeURIComponent(expr)}.png`;
    } else if (step === 1 && agent) {
      img.dataset.step = "2";
      img.src = `assets/avatars/${encodeURIComponent(agent)}.png`;
    } else {
      img.hidden = true;
    }
  },
  true,
);
document.querySelector("#completion-return").addEventListener("click", returnToAgentFromCompletion);
document.querySelector("#completion-close").addEventListener("click", closeCompletion);
document.querySelector("#completion-top-close").addEventListener("click", closeCompletion);
document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
document.querySelector("#settings-close").addEventListener("click", closeSettings);
document.querySelector("#simulate-button").addEventListener("click", () => window.agentPet.simulate());
document.querySelector("#interaction-top-close").addEventListener("click", dismissInteraction);
document.querySelector("#interaction-bottom-close").addEventListener("click", dismissInteraction);
elements.interactionConfirm.addEventListener("click", submitInteraction);
elements.sessionList.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-open-interaction]") : null;
  if (!button) return;
  const session = snapshot.sessions.find((item) => item.pendingInteraction?.eventId === button.dataset.openInteraction);
  if (session) openInteraction(session);
});

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".tab")];
    const current = tabs.indexOf(tab);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(current + direction + tabs.length) % tabs.length];
    next.focus();
    activateTab(next.dataset.tab);
  });
}

elements.searchInput.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
  activateTab("history");
});

elements.petSize.addEventListener("input", () => applyPetSize(elements.petSize.value, true));
for (const option of document.querySelectorAll(".motion-option")) {
  option.addEventListener("click", () => applyMotionPreference(option.dataset.motion, true));
}
restorePetPreferences();

// 状态框摆哪边由主进程算好推过来（看幼苗在屏幕哪半边）
window.agentPet.onNoteSide((side) => { document.body.dataset.noteSide = side === "left" ? "left" : "right"; });
// 「详情 / 设置」已从幼苗脚下撤走，改从托盘菜单进
window.agentPet.onPetCommand((command) => {
  if (command === "drawer") openDrawer();
  else if (command === "settings") openSettings();
});

window.agentPet.onSnapshot((next) => renderSnapshot(next));
window.agentPet.snapshot().then(renderSnapshot);
runSearch();
setInterval(() => {
  if (!drawerOpen) return;
  window.agentPet.snapshot().then(renderSnapshot).catch(() => {});
  if (activeTab === "diagnostics") renderDiagnostics();
}, 2_500);
setInterval(runAmbientMotion, 1_000);
// 卡顿检测：Agent 卡了 5 分钟没动静要亮红灯，但这事不一定有新事件推过来，
// 所以定时自己刷一遍座位灯色（灯色按当前时间重算，灯没变就不重画）。
setInterval(() => { renderSeats(snapshot.sessions); }, 10_000);
