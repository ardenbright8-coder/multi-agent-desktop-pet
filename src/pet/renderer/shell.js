// 界面底座：DOM 引用、文案表、共享状态、通用小工具、总调度 renderSnapshot。
// 这几个 script 是普通 script（不是 ES module），共享同一个全局作用域，所以这份必须第一个加载：
// 后面几份要用的 const/let 都在这儿声明，先声明后使用，顺序别调。

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
