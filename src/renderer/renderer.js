const elements = {
  drawer: document.querySelector("#drawer"),
  settings: document.querySelector("#settings-panel"),
  permission: document.querySelector("#permission-ticket"),
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
  thinking: "running",
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
let movementTimer = null;
let previewTimer = null;
let ambientNextAt = Date.now() + 7_000;
let motionPreference = "lively";

document.addEventListener("mousemove", (event) => {
  const target = event.target;
  const interactive = target instanceof Element && Boolean(target.closest("[data-interactive]"));
  window.agentPet.setMousePassthrough(!interactive);
});

document.querySelector("#pet").addEventListener("click", toggleDrawer);
document.querySelector("#status-note").addEventListener("click", toggleDrawer);
document.querySelector("#open-button").addEventListener("click", openDrawer);
document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
document.querySelector("#settings-button").addEventListener("click", toggleSettings);
document.querySelector("#settings-close").addEventListener("click", closeSettings);
document.querySelector("#hide-button").addEventListener("click", () => window.agentPet.hideWindow());
document.querySelector("#simulate-button").addEventListener("click", () => window.agentPet.simulate());
document.querySelector("#ticket-detail-button").addEventListener("click", () => {
  openDrawer();
  activateTab("sessions");
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
for (const button of document.querySelectorAll("[data-preview-pose]")) {
  button.addEventListener("click", () => previewPose(button.dataset.previewPose));
}

restorePetPreferences();

window.agentPet.onSnapshot((next) => renderSnapshot(next));
window.agentPet.onPetMotion?.((direction) => showMovement(direction));
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
  const pending = next.sessions.find((session) => session.pendingPermission);
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
  renderPermission(pending);
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
      ${session.pendingPermission ? `<p class="permission-inline"><strong>等待处理：</strong>${escapeHtml(session.pendingPermission.request)}</p>` : ""}
      <div class="row-meta">${escapeHtml(session.sessionId)} · ${formatTime(session.updatedAt)}</div>
    </article>
  `).join("");
}

function renderPermission(session) {
  const pending = session?.pendingPermission;
  if (!pending || drawerOpen || settingsOpen) {
    elements.permission.hidden = true;
    return;
  }
  elements.permission.hidden = false;
  document.querySelector("#ticket-agent").textContent = labels[session.agent] || session.agent;
  document.querySelector("#ticket-heading").textContent = pending.heading;
  document.querySelector("#ticket-context").textContent = `${session.project} · 会话 ${session.sessionId}`;
  document.querySelector("#ticket-doing").textContent = pending.doing;
  document.querySelector("#ticket-request").textContent = pending.request;
  document.querySelector("#ticket-reason").textContent = pending.reason;
  document.querySelector("#ticket-impact").textContent = pending.impact;
  const risk = document.querySelector("#ticket-risk");
  risk.className = `risk risk-${pending.risk}`;
  risk.textContent = { low: "低风险", medium: "中风险", high: "高风险", unknown: "待核实" }[pending.risk];
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
  closeSettings(false);
  drawerOpen = true;
  elements.drawer.hidden = false;
  elements.permission.hidden = true;
  updatePetPose();
  renderDiagnostics();
}
function closeDrawer() {
  drawerOpen = false;
  elements.drawer.hidden = true;
  renderPermission(snapshot.sessions.find((session) => session.pendingPermission));
  updatePetPose();
}

function toggleSettings() { settingsOpen ? closeSettings() : openSettings(); }
function openSettings() {
  if (drawerOpen) closeDrawer();
  settingsOpen = true;
  elements.settings.hidden = false;
  elements.permission.hidden = true;
  previewPose("jumping", 1_450);
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
  if (restorePermission) renderPermission(snapshot.sessions.find((session) => session.pendingPermission));
}

function updatePetPose() {
  if (movementTimer || celebrationTimer || previewTimer) return;
  const state = snapshot.sessions[0]?.state || "idle";
  const important = state === "waiting" || state === "error";
  setPetPose((drawerOpen || settingsOpen) && !important ? "review" : poseByState[state]);
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

function showMovement(direction) {
  const state = snapshot.sessions[0]?.state || "idle";
  if (state === "waiting" || state === "error") return;
  if (movementTimer) clearTimeout(movementTimer);
  setPetPose(direction === "left" ? "running-left" : "running-right");
  movementTimer = setTimeout(() => {
    movementTimer = null;
    updatePetPose();
  }, 260);
}

function previewPose(pose, duration) {
  if (previewTimer) clearTimeout(previewTimer);
  if (celebrationTimer) {
    clearTimeout(celebrationTimer);
    celebrationTimer = null;
  }
  setPetPose(pose);
  const defaultDuration = pose === "jumping" ? 1_500 : pose.startsWith("running-") ? 1_150 : 2_050;
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
  if (motionPreference === "calm" || drawerOpen || settingsOpen || state !== "idle" || movementTimer || celebrationTimer || previewTimer) {
    ambientNextAt = Date.now() + 3_000;
    return;
  }
  const poses = motionPreference === "lively" ? ["waving", "jumping", "review", "jumping"] : ["waving", "review", "jumping"];
  previewPose(poses[Math.floor(Math.random() * poses.length)]);
  ambientNextAt = Date.now() + (motionPreference === "lively" ? 5_500 : 10_000);
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
