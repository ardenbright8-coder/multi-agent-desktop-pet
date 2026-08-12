// 幼苗本身：姿态、庆祝、随机小动作、拿起放下，以及设置面板里的大小和活泼程度。
// 状态在 shell.js 里声明，这份只管改它。

function updatePetPose() {
  if (celebrationTimer || previewTimer) return;
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

function previewPose(pose, duration) {
  if (previewTimer) clearTimeout(previewTimer);
  if (celebrationTimer) {
    clearTimeout(celebrationTimer);
    celebrationTimer = null;
  }
  setPetPose(pose);
  const defaultDuration = pose === "jumping" ? 1_500 : pose.startsWith("working-") ? 2_300 : 2_050;
  previewTimer = setTimeout(() => {
    previewTimer = null;
    updatePetPose();
  }, duration || defaultDuration);
}

function runAmbientMotion() {
  if (Date.now() < ambientNextAt) return;
  const state = snapshot.sessions[0]?.state || "idle";
  if (motionPreference === "calm" || drawerOpen || settingsOpen || celebrationTimer || previewTimer) {
    ambientNextAt = Date.now() + 3_000;
    return;
  }
  if (state === "working") {
    const workingPoses = motionPreference === "lively" ? ["running", "working-rope", "working-focus"] : ["running", "working-focus"];
    previewPose(workingPoses[Math.floor(Math.random() * workingPoses.length)], 2_300);
    ambientNextAt = Date.now() + (motionPreference === "lively" ? 3_600 : 6_000);
    return;
  }
  if (state !== "idle") {
    ambientNextAt = Date.now() + 3_000;
    return;
  }
  const poses = motionPreference === "lively" ? ["waving", "jumping", "review", "jumping"] : ["waving", "review", "jumping"];
  previewPose(poses[Math.floor(Math.random() * poses.length)]);
  ambientNextAt = Date.now() + (motionPreference === "lively" ? 5_500 : 10_000);
}

// 拖动：按住幼苗直接拖，松手放下——跟别的桌面宠物一个手感。
// （旧版是"点一下拿起、再点一下放下"，拖到别的屏幕就找不着幼苗、也就再也放不下，已废弃。）
function beginPetDrag(event) {
  if (event.button !== 0) return;
  // 🚨 这里千万别调 event.preventDefault()。
  // 在 pointerdown 上 preventDefault 会把浏览器后续合成的 mousemove／mouseup 一起掐掉，
  // 结果就是"按得下去、拖不动"（2026-08-12 实机踩的）。挡拖影是在 dragstart 上挡的。
  petPickedUp = true;
  document.body.classList.add("pet-picked-up");
  elements.pet.setAttribute("aria-pressed", "true");
  elements.pet.setAttribute("aria-label", "松手放下幼苗");
  if (event.pointerId !== undefined && elements.pet.setPointerCapture) {
    try { elements.pet.setPointerCapture(event.pointerId); } catch { /* 捕获失败不影响拖动 */ }
  }
  // 只告诉主进程「鼠标按在窗口里的哪个点」，剩下的它自己读系统光标去算，别在这儿传屏幕坐标。
  window.agentPet.startDragging({ x: event.clientX, y: event.clientY });
}

function endPetDrag(event) {
  if (!petPickedUp) return;
  petPickedUp = false;
  document.body.classList.remove("pet-picked-up");
  elements.pet.setAttribute("aria-pressed", "false");
  elements.pet.setAttribute("aria-label", "按住幼苗拖动，松手放下");
  if (event?.pointerId !== undefined && elements.pet.releasePointerCapture) {
    try { elements.pet.releasePointerCapture(event.pointerId); } catch { /* 已经自动释放了 */ }
  }
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
  settingsOpen = true;
  if (drawerOpen) closeDrawer();
  elements.settings.hidden = false;
  elements.interaction.hidden = true;
  syncPanelVisibility();
}

function closeSettings(restorePermission = true) {
  if (!settingsOpen) return;
  settingsOpen = false;
  elements.settings.hidden = true;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  updatePetPose();
  if (restorePermission) renderInteraction(snapshot.sessions.find((session) => session.pendingInteraction?.eventId === activeInteractionEventId));
  syncPanelVisibility();
}

function restorePetPreferences() {
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem("agent-pet:appearance") || "{}"); } catch { preferences = {}; }
  applyPetSize(preferences.size || 100, false);
  applyMotionPreference(preferences.motion || "lively", false);
}

function applyPetSize(value, persist) {
  const size = Math.max(70, Math.min(140, Number(value) || 100));
  elements.pet.style.setProperty("--user-pet-scale", String(size / 100));
  elements.petSize.value = String(size);
  elements.petSizeValue.textContent = `${size}%`;
  if (persist) savePetPreferences();
}

function applyMotionPreference(value, persist) {
  motionPreference = ["calm", "normal", "lively"].includes(value) ? value : "lively";
  document.body.dataset.motion = motionPreference;
  for (const option of document.querySelectorAll(".motion-option")) {
    const selected = option.dataset.motion === motionPreference;
    option.classList.toggle("active", selected);
    option.setAttribute("aria-pressed", String(selected));
  }
  ambientNextAt = Date.now() + (motionPreference === "lively" ? 4_000 : 8_000);
  if (persist) savePetPreferences();
}

function savePetPreferences() {
  try {
    localStorage.setItem("agent-pet:appearance", JSON.stringify({ size: Number(elements.petSize.value), motion: motionPreference }));
  } catch { /* appearance preferences are optional */ }
}
