const elements = {
  drawer: document.querySelector("#drawer"),
  settings: document.querySelector("#settings-panel"),
  interaction: document.querySelector("#interaction-panel"),
  interactionPrompts: document.querySelector("#interaction-prompts"),
  interactionError: document.querySelector("#interaction-error"),
  interactionConfirm: document.querySelector("#interaction-confirm"),
  pet: document.querySelector("#pet"),
  statusAgent: document.querySelector("#status-agent"),
  statusCopy: document.querySelector("#status-copy"),
  statusState: document.querySelector("#status-state"),
  sessionList: document.querySelector("#session-list"),
  searchInput: document.querySelector("#search-input"),
  searchState: document.querySelector("#search-state"),
  searchResults: document.querySelector("#search-results"),
  diagnosticsList: document.querySelector("#diagnostics-list"),
  petSize: document.querySelector("#pet-size"),
  petSizeValue: document.querySelector("#pet-size-value"),
};

const labels = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  pi: "Pi",
  hermes: "Hermes",
  simulator: "模拟 Agent",
};

const stateCopy = {
  idle: "连接正常，正在等消息",
  thinking: "正在理解任务",
  working: "正在执行工具",
  waiting: "需要你回来处理",
  done: "任务完成了",
  error: "任务遇到错误",
};

const stateLabel = {
  idle: "空闲",
  thinking: "正在理解",
  working: "正在工作",
  waiting: "需要你处理",
  done: "完成未读",
  error: "遇到阻塞",
};

const poseByState = {
  idle: "idle",
  thinking: "thinking",
  working: "running",
  waiting: "waiting",
  done: "waving",
  error: "failed",
};

let snapshot = { sessions: [], activeCount: 0, eventCount: 0, topState: "idle" };
let drawerOpen = false;
let settingsOpen = false;
let searchTimer = null;
let searchGeneration = 0;
let activeTab = "sessions";
let lastLeadIdentity = "";
let celebrationTimer = null;
let previewTimer = null;
let ambientNextAt = Date.now() + 7_000;
let motionPreference = "lively";
let activeInteractionEventId = null;
let interactionSubmitting = false;
let petPickedUp = false;
let pickupAnchor = null;
let panelVisible = false;
const dismissedInteractions = new Set();

document.addEventListener("mousemove", (event) => {
  if (petPickedUp && pickupAnchor) {
    window.agentPet.moveWindowToPointer({
      screenX: event.screenX,
      screenY: event.screenY,
      anchorX: pickupAnchor.x,
      anchorY: pickupAnchor.y,
    });
    return;
  }
});

document.querySelector("#pet").addEventListener("click", togglePetPickup);
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

function renderSnapshot(next) {
  snapshot = next;
  const lead = next.sessions[0];
  let pending = activeInteractionEventId
    ? next.sessions.find((session) => session.pendingInteraction?.eventId === activeInteractionEventId)
    : undefined;
  if (!pending) pending = next.sessions.find((session) => session.pendingInteraction && !dismissedInteractions.has(session.pendingInteraction.eventId));
  const state = lead?.state || "idle";
  const identity = lead ? `${lead.key}:${lead.state}` : "idle";
  const changed = identity !== lastLeadIdentity;
  document.body.dataset.state = state;
  elements.statusAgent.textContent = lead ? (labels[lead.agent] || lead.agent) : "事件中心";
  elements.statusCopy.textContent = lead?.summary || stateCopy[state];
  elements.statusState.textContent = stateLabel[state];
  if ((state === "waiting" || state === "error") && celebrationTimer) {
    clearTimeout(celebrationTimer);
    celebrationTimer = null;
  }
  if (changed && state === "done") celebrateCompletion();
  else if (!celebrationTimer) updatePetPose();
  lastLeadIdentity = identity;
  renderSessions(next.sessions);
  if (!interactionSubmitting) renderInteraction(pending);
  if (drawerOpen) renderDiagnostics();
}

function renderSessions(sessions) {
  if (!sessions.length) {
    elements.sessionList.innerHTML = `<div class="empty-state">还没有收到 Agent 事件。<br>可以先发送一条测试事件。</div>`;
    return;
  }
  elements.sessionList.innerHTML = sessions.map((session) => `
    <article class="list-row">
      <div class="row-line">
        <i class="state-dot ${escapeHtml(session.state)}"></i>
        <strong>${escapeHtml(session.project || session.title)}</strong>
        <small>${escapeHtml(labels[session.agent] || session.agent)}</small>
      </div>
      <p>${escapeHtml(session.summary || stateCopy[session.state])}</p>
      ${session.pendingInteraction ? `<button class="pending-inline" data-open-interaction="${escapeHtml(session.pendingInteraction.eventId)}" type="button"><strong>${session.pendingInteraction.mode === "question" ? "待回答" : "待授权"}：</strong>${escapeHtml(session.pendingInteraction.title)}</button>` : ""}
      <div class="row-meta">${escapeHtml(session.sessionId)} · ${formatTime(session.updatedAt)}</div>
    </article>
  `).join("");
}

function renderInteraction(session) {
  const pending = session?.pendingInteraction;
  if (!pending || drawerOpen || settingsOpen || dismissedInteractions.has(pending.eventId)) {
    elements.interaction.hidden = true;
    if (!pending || pending.eventId === activeInteractionEventId) activeInteractionEventId = null;
    syncPanelVisibility();
    return;
  }
  activeInteractionEventId = pending.eventId;
  elements.interaction.hidden = false;
  document.querySelector("#interaction-agent").textContent = labels[session.agent] || session.agent;
  const type = document.querySelector("#interaction-type");
  type.textContent = pending.mode === "question" ? "询问" : "权限";
  type.className = `type-badge ${pending.mode}`;
  document.querySelector("#interaction-heading").textContent = pending.title;
  document.querySelector("#interaction-explanation").textContent = pending.explanation;
  elements.interactionPrompts.innerHTML = pending.prompts.map(renderPrompt).join("");
  const fallback = document.querySelector("#interaction-fallback");
  fallback.hidden = pending.responseCapability;
  elements.interactionConfirm.disabled = !pending.responseCapability || pending.prompts.length === 0 || pending.responseStatus === "submitting";
  elements.interactionConfirm.textContent = pending.responseCapability ? (pending.responseStatus === "submitting" ? "正在交回…" : "确认") : "回原窗口处理";
  elements.interactionError.hidden = !pending.responseError;
  elements.interactionError.textContent = pending.responseError || "";
  syncPanelVisibility();
}

function renderPrompt(prompt, promptIndex) {
  const inputType = prompt.multiple ? "checkbox" : "radio";
  const options = prompt.options.map((option) => `
    <label class="interaction-option">
      <input type="${inputType}" name="prompt-${promptIndex}" value="${escapeHtml(option.id)}" />
      <span><strong>${escapeHtml(option.label)}${option.recommended ? '<small>推荐</small>' : ""}</strong>${option.description ? `<em>${escapeHtml(option.description)}</em>` : ""}</span>
    </label>
  `).join("");
  const custom = prompt.allowCustomInput ? `
    <label class="interaction-option custom-choice">
      <input type="${inputType}" name="prompt-${promptIndex}" value="__custom__" />
      <span><strong>自己输入</strong><em>按你的原话交回 Agent，不替你扩写。</em></span>
    </label>
    <textarea data-custom-input="${escapeHtml(prompt.id)}" rows="3" placeholder="写下你的做法、限制或回答"></textarea>
  ` : "";
  return `<fieldset class="interaction-prompt" data-prompt-id="${escapeHtml(prompt.id)}"><legend>${escapeHtml(prompt.question)}</legend>${options}${custom}</fieldset>`;
}

function currentInteractionSession() {
  return snapshot.sessions.find((session) => session.pendingInteraction?.eventId === activeInteractionEventId);
}

function dismissInteraction() {
  if (interactionSubmitting) return;
  if (activeInteractionEventId) dismissedInteractions.add(activeInteractionEventId);
  activeInteractionEventId = null;
  elements.interaction.hidden = true;
  syncPanelVisibility();
}

function openInteraction(session) {
  closeDrawer();
  closeSettings(false);
  const eventId = session.pendingInteraction.eventId;
  dismissedInteractions.delete(eventId);
  activeInteractionEventId = eventId;
  renderInteraction(session);
}

async function submitInteraction() {
  const session = currentInteractionSession();
  const pending = session?.pendingInteraction;
  if (!session || !pending || !pending.responseCapability || interactionSubmitting) return;
  const answers = [];
  for (const prompt of pending.prompts) {
    const fieldset = elements.interactionPrompts.querySelector(`[data-prompt-id="${cssEscape(prompt.id)}"]`);
    const selected = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
    const customSelected = selected.includes("__custom__");
    const customText = customSelected ? fieldset.querySelector("textarea")?.value.trim() : "";
    const optionIds = selected.filter((value) => value !== "__custom__");
    if ((!optionIds.length && !customText) || (customSelected && !customText)) {
      showInteractionError("请先为每个问题选择一项，或写下自己的回答。");
      return;
    }
    answers.push({ promptId: prompt.id, optionIds, customText: customText || undefined });
  }
  interactionSubmitting = true;
  elements.interactionConfirm.disabled = true;
  elements.interactionConfirm.textContent = "正在交回…";
  showInteractionError("");
  let result;
  try {
    result = await window.agentPet.respondInteraction({
      eventId: pending.eventId,
      agent: session.agent,
      sessionId: session.sessionId,
      providerRequestId: pending.providerRequestId,
      answers,
    });
  } catch {
    result = { ok: false, message: "桌宠回传链路出错，请回原窗口处理或重试。" };
  }
  interactionSubmitting = false;
  if (result.ok) {
    dismissedInteractions.add(pending.eventId);
    activeInteractionEventId = null;
    elements.interaction.hidden = true;
    syncPanelVisibility();
    return;
  }
  elements.interactionConfirm.disabled = false;
  elements.interactionConfirm.textContent = "确认";
  showInteractionError(result.message);
}

function showInteractionError(message) {
  elements.interactionError.hidden = !message;
  elements.interactionError.textContent = message;
}

async function runSearch() {
  const generation = ++searchGeneration;
  const text = elements.searchInput.value.trim();
  elements.searchState.hidden = false;
  elements.searchState.textContent = "正在查找…";
  let hits;
  try {
    hits = await window.agentPet.search({ text, limit: 40 });
  } catch {
    if (generation !== searchGeneration) return;
    elements.searchState.hidden = false;
    elements.searchState.textContent = "搜索暂时失败，请稍后重试。";
    elements.searchResults.innerHTML = "";
    return;
  }
  if (generation !== searchGeneration) return;
  elements.searchState.hidden = hits.length > 0;
  elements.searchState.textContent = text ? "没有搜到对应内容。" : "还没有历史事件。";
  elements.searchResults.innerHTML = hits.map(({ event, score }) => `
    <article class="list-row">
      <div class="row-line">
        <i class="state-dot ${stateFromKind(event.kind)}"></i>
        <strong>${escapeHtml(event.title || event.summary || event.kind)}</strong>
        <small>${escapeHtml(labels[event.agent] || event.agent)}</small>
      </div>
      <p>${escapeHtml(event.summary || event.reason || "没有补充说明")}</p>
      <div class="row-meta">会话 ${escapeHtml(event.sessionId)} · ${escapeHtml(event.tool || event.kind)}${event.target ? ` · ${escapeHtml(event.target)}` : ""}${score ? ` · 相关度 ${Math.round(score * 10) / 10}` : ""}</div>
    </article>
  `).join("");
}

async function renderDiagnostics() {
  let data;
  try {
    data = await window.agentPet.diagnostics();
  } catch {
    elements.diagnosticsList.innerHTML = diagnosticRow("事件中心", "无法读取诊断，请重启桌宠", "status-warn");
    return;
  }
  const integrationRows = data.integrations.map((item) => {
    const text = item.status === "connected" ? "刚收到事件" : item.status === "seen" ? "以前连通过" : item.status === "planned" ? "适配器待接" : "尚未见到";
    const cls = item.status === "connected" ? "status-ok" : "status-warn";
    return diagnosticRow(item.label, text, cls);
  }).join("");
  elements.diagnosticsList.innerHTML = [
    diagnosticRow("本机事件中心", data.server.running ? "正常" : "异常", data.server.running ? "status-ok" : "status-warn"),
    diagnosticRow("传输方式", "Windows 命名管道", "status-ok"),
    diagnosticRow("实时索引", `${data.journal.count} 条事件`, "status-ok"),
    diagnosticRow("接收统计", `${data.events.accepted} 正常 · ${data.events.duplicate} 重复 · ${data.events.stale} 迟到`, ""),
    diagnosticRow("最近通信", data.events.lastAcceptedAt ? formatTime(data.events.lastAcceptedAt) : "还没收到真实事件", data.events.lastAcceptedAt ? "status-ok" : "status-warn"),
    diagnosticRow("断线处理", data.server.running ? "下一条事件自动重发现" : "重启桌宠后自动重建管道", data.server.running ? "" : "status-warn"),
    integrationRows,
  ].join("");
}

function diagnosticRow(label, value, cls) {
  return `<div class="diagnostic-row"><span>${escapeHtml(label)}</span><strong class="${cls}">${escapeHtml(value)}</strong></div>`;
}

function toggleDrawer() { drawerOpen ? closeDrawer() : openDrawer(); }
function openDrawer() {
  drawerOpen = true;
  closeSettings(false);
  elements.drawer.hidden = false;
  elements.interaction.hidden = true;
  updatePetPose();
  renderDiagnostics();
  syncPanelVisibility();
}
function closeDrawer() {
  drawerOpen = false;
  elements.drawer.hidden = true;
  renderInteraction(snapshot.sessions.find((session) => session.pendingInteraction?.eventId === activeInteractionEventId));
  updatePetPose();
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

function togglePetPickup(event) {
  if (petPickedUp) {
    petPickedUp = false;
    pickupAnchor = null;
    document.body.classList.remove("pet-picked-up");
    elements.pet.setAttribute("aria-pressed", "false");
    elements.pet.setAttribute("aria-label", "点一下拿起幼苗，再点一下放下");
    window.agentPet.setPetPickedUp(false);
    window.agentPet.finishWindowMove();
    return;
  }
  petPickedUp = true;
  pickupAnchor = { x: event.clientX, y: event.clientY };
  document.body.classList.add("pet-picked-up");
  elements.pet.setAttribute("aria-pressed", "true");
  elements.pet.setAttribute("aria-label", "再点一下放下幼苗");
  window.agentPet.setPetPickedUp(true);
}

function syncPanelVisibility() {
  const visible = drawerOpen || settingsOpen || !elements.interaction.hidden;
  if (panelVisible === visible) return;
  panelVisible = visible;
  window.agentPet.setPanelVisibility(visible);
}

function activateTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll(".tab")) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  for (const view of document.querySelectorAll(".view")) view.classList.toggle("active", view.id === `${name}-view`);
  if (name === "history") runSearch();
  if (name === "diagnostics") renderDiagnostics();
}

function stateFromKind(kind) {
  if (kind === "permission.requested" || kind === "question.asked") return "waiting";
  if (kind === "task.failed") return "error";
  if (kind === "task.completed") return "done";
  if (kind === "state.working") return "working";
  if (kind === "state.thinking") return "thinking";
  return "idle";
}

function formatTime(time) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(time));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
