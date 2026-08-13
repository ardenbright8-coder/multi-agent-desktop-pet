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
  completionPanel: document.querySelector("#completion-panel"),
  completionAgent: document.querySelector("#completion-agent"),
  completionHeading: document.querySelector("#completion-heading"),
  completionExplanation: document.querySelector("#completion-explanation"),
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
  working: "working-typing",
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
let panelVisible = false;
let hoveringInteractive = false;
const dismissedInteractions = new Set();
let completionOpen = false;

// 完成弹窗：任何 Agent 干完活（task.completed）就弹，跟权限/询问一个壳。
// 任务接任务时跳跃会被盖，弹窗不会——干完必须看得见（用户 2026-08-12 明确要求）。
// 两个按钮：回原窗口（收起弹窗去 Agent 那边看）／关闭。
function showCompletion(summary, agentName) {
  if (drawerOpen) closeDrawer();
  if (settingsOpen) closeSettings(false);
  elements.interaction.hidden = true;
  elements.completionAgent.textContent = agentName || "Agent";
  elements.completionHeading.textContent = "任务完成了";
  elements.completionExplanation.textContent = summary || "Agent 已经把活干完了，去原窗口看结果吧。";
  elements.completionPanel.hidden = false;
  completionOpen = true;
  syncPanelVisibility();
}

function closeCompletion() {
  if (!completionOpen) return;
  completionOpen = false;
  elements.completionPanel.hidden = true;
  syncPanelVisibility();
}

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
  if (changed && state === "done") {
    celebrateCompletion();
    // 干完必须看得见：弹完成通知窗（跳跃会被下一个任务盖掉，弹窗不会）
    showCompletion(lead?.summary, labels[lead?.agent] || lead?.agent || "Agent");
  }
  else if (!celebrationTimer) updatePetPose();
  lastLeadIdentity = identity;
  renderSessions(next.sessions);
  if (!interactionSubmitting) renderInteraction(pending);
  if (drawerOpen) renderDiagnostics();
}

function syncPanelVisibility() {
  const visible = drawerOpen || settingsOpen || completionOpen || !elements.interaction.hidden;
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
