// 幼苗本身：姿态、庆祝、拖动，以及设置面板里的活泼程度。
// 幼苗 2026-08-14 已隐藏；2026-10-01 删了没效果的大小滑杆和每秒跑一次的随机小动作。
// 状态在 shell.js 里声明，这份只管改它。

function updatePetPose() {
  if (celebrationTimer) return;
  const state = snapshot.sessions[0]?.state || "idle";
  setPetPose(poseByState[state]);
}

function setPetPose(pose) {
  document.body.dataset.petPose = pose;
}

function celebrateCompletion() {
  if (celebrationTimer) clearTimeout(celebrationTimer);
  setPetPose("jumping");
  celebrationTimer = setTimeout(() => {
    celebrationTimer = null;
    updatePetPose();
  }, 1_450);
}

// 拖动：按住幼苗直接拖，松手放下——跟别的桌面宠物一个手感。
// （旧版是"点一下拿起、再点一下放下"，拖到别的屏幕就找不着幼苗、也就再也放不下，已废弃。）
// 2026-08-14：桌面幼苗移除，拖动改为「按住窗口主体（画框）移动整个窗口」。
let dragTarget = null;
function beginPetDrag(event, targetEl) {
  if (event.button !== 0) return;
  // 🚨 这里千万别调 event.preventDefault()。
  // 在 pointerdown 上 preventDefault 会把浏览器后续合成的 mousemove／mouseup 一起掐掉，
  // 结果就是"按得下去、拖不动"（2026-08-12 实机踩的）。挡拖影是在 dragstart 上挡的。
  dragTarget = targetEl || elements.pet;
  petPickedUp = true;
  document.body.classList.add("pet-picked-up");
  if (event.pointerId !== undefined && dragTarget.setPointerCapture) {
    try { dragTarget.setPointerCapture(event.pointerId); } catch { /* 捕获失败不影响拖动 */ }
  }
  // 只告诉主进程「鼠标按在窗口里的哪个点」，剩下的它自己读系统光标去算，别在这儿传屏幕坐标。
  const rect = dragTarget.getBoundingClientRect();
  window.agentPet.startDragging({
    x: event.clientX,
    y: event.clientY,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    dpr: window.devicePixelRatio,
    petTop: Math.round(rect.top),
    petLeft: Math.round(rect.left),
    petW: Math.round(rect.width),
    petH: Math.round(rect.height),
  });
}

function endPetDrag(event) {
  if (!petPickedUp) return;
  petPickedUp = false;
  document.body.classList.remove("pet-picked-up");
  if (event?.pointerId !== undefined && dragTarget?.releasePointerCapture) {
    try { dragTarget.releasePointerCapture(event.pointerId); } catch { /* 已经自动释放了 */ }
  }
  dragTarget = null;
  window.agentPet.stopDragging();
  syncHitTest(event);
}

// 鼠标压在"可点的东西"上时才收回穿透，其余时候整窗让开，别挡住底下的程序。
// 靠 CSS 判断：透明区域是 pointer-events:none，只有 [data-interactive] 是 auto，
// 所以 elementFromPoint 命中什么，就是真的能点到什么。
function syncHitTest(event) {
  if (petPickedUp) return;
  const x = event?.clientX;
  const y = event?.clientY;
  const target = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
  const interactive = Boolean(target && target.closest("[data-interactive]"));
  if (interactive === hoveringInteractive) return;
  hoveringInteractive = interactive;
  window.agentPet.setHoveringInteractive(interactive);
}

function toggleSettings() { settingsOpen ? closeSettings() : openSettings(); }

function openSettings() {
  openPanel("settings");
  settingsOpen = true;
  elements.settings.hidden = false;
  elements.interaction.hidden = true;
  syncPanelVisibility();
}

function closeSettings(restorePermission = true) {
  if (!settingsOpen) return;
  settingsOpen = false;
  elements.settings.hidden = true;
  updatePetPose();
  if (restorePermission) restoreInteractionAfterPanelClose();
  syncPanelVisibility();
}

function restorePetPreferences() {
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem("agent-pet:appearance") || "{}"); } catch { preferences = {}; }
  applyMotionPreference(preferences.motion || "lively", false);
}

function applyMotionPreference(value, persist) {
  motionPreference = ["calm", "normal", "lively"].includes(value) ? value : "lively";
  document.body.dataset.motion = motionPreference;
  for (const option of document.querySelectorAll(".motion-option")) {
    const selected = option.dataset.motion === motionPreference;
    option.classList.toggle("active", selected);
    option.setAttribute("aria-pressed", String(selected));
  }
  if (persist) savePetPreferences();
}

function savePetPreferences() {
  try {
    localStorage.setItem("agent-pet:appearance", JSON.stringify({ motion: motionPreference }));
  } catch { /* appearance preferences are optional */ }
}
