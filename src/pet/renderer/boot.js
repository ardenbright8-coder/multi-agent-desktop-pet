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
document.querySelector("#pet").addEventListener("pointerdown", beginPetDrag);
document.querySelector("#pet").addEventListener("dragstart", (event) => event.preventDefault());
document.addEventListener("pointerup", endPetDrag);
document.addEventListener("mouseup", endPetDrag);
document.addEventListener("pointercancel", endPetDrag);
window.addEventListener("blur", () => endPetDrag());
document.querySelector("#status-note").addEventListener("click", toggleDrawer);
document.querySelector("#open-button").addEventListener("click", openDrawer);
document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
document.querySelector("#settings-button").addEventListener("click", toggleSettings);
document.querySelector("#settings-close").addEventListener("click", closeSettings);
document.querySelector("#hide-button").addEventListener("click", () => window.agentPet.hideWindow());
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

window.agentPet.onSnapshot((next) => renderSnapshot(next));
window.agentPet.snapshot().then(renderSnapshot);
runSearch();
setInterval(() => {
  if (!drawerOpen) return;
  window.agentPet.snapshot().then(renderSnapshot).catch(() => {});
  if (activeTab === "diagnostics") renderDiagnostics();
}, 2_500);
setInterval(runAmbientMotion, 1_000);
