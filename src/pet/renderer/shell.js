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
  statusNote: document.querySelector("#status-note"),
  completionPanel: document.querySelector("#completion-panel"),
  completionAgent: document.querySelector("#completion-agent"),
  completionHeading: document.querySelector("#completion-heading"),
  completionExplanation: document.querySelector("#completion-explanation"),
  noticePanel: document.querySelector("#notice-panel"),
  noticeSource: document.querySelector("#notice-source"),
  noticeBadge: document.querySelector("#notice-badge"),
  noticeHeading: document.querySelector("#notice-heading"),
  noticeExplanation: document.querySelector("#notice-explanation"),
  agentSeats: document.querySelector("#agent-seats"),
  sessionList: document.querySelector("#session-list"),
  searchInput: document.querySelector("#search-input"),
  searchState: document.querySelector("#search-state"),
  searchResults: document.querySelector("#search-results"),
  diagnosticsList: document.querySelector("#diagnostics-list"),
};

const labels = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  pi: "Pi",
  hermes: "Hermes",
  grok: "Grok",
  codex: "Codex",
  antigravity: "Antigravity",
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
let celebrationTimer = null;
let motionPreference = "lively";
let activeInteractionEventId = null;
let interactionSubmitting = false;
let petPickedUp = false;
let panelVisible = false;
let hoveringInteractive = false;
const dismissedInteractions = new Set();
let completionOpen = false;
let completionTarget = null;
let completionHydrated = false;
let queuedCompletion = null;
const lastSessionState = new Map();
let noticeOpen = false;
let noticeHovered = false;
let noticeOpenedAt = 0;
let noticeEndAt = 0;
let noticeCloseTimer = null;
let noticeTickTimer = null;
let lastSeenNoticeId = null;

// 完成弹窗：只有某个会话「新进入 done」才弹。
// 以前用 lead 身份变化判断——已经点掉的完成会话一回到队首就再弹一次，看着像乱弹。
function showCompletion(session) {
  const hasActivePending = Boolean(
    activeInteractionEventId
    || snapshot.sessions?.some((item) => item.pendingInteraction && !dismissedInteractions.has(item.pendingInteraction.eventId)),
  );
  if (hasActivePending) {
    queuedCompletion = session;
    return;
  }
  openPanel("completion");
  const agentName = labels[session?.agent] || session?.agent || "Agent";
  elements.completionAgent.textContent = agentName;
  elements.completionHeading.textContent = "任务完成了";
  elements.completionExplanation.textContent = session?.summary || "Agent 已经把活干完了，去原窗口看结果吧。";
  completionTarget = session ? { agent: session.agent, project: session.project, originPid: session.originPid } : null;
  elements.completionPanel.hidden = false;
  completionOpen = true;
  syncPanelVisibility();
}

// 纯提示窗（2026-11-01 新增）：无底部按钮，只供查看。
// 不碰它 6 秒自动关；鼠标放上去立刻暂停倒计时；鼠标移开 1.5 秒自动关；点一下当场秒关。
function clearNoticeTimers() {
  if (noticeCloseTimer) {
    clearTimeout(noticeCloseTimer);
    noticeCloseTimer = null;
  }
  if (noticeTickTimer) {
    clearInterval(noticeTickTimer);
    noticeTickTimer = null;
  }
}

function startNoticeCountdown(ms) {
  clearNoticeTimers();
  noticeEndAt = Date.now() + ms;
  const updateBadge = () => {
    if (noticeHovered) {
      elements.noticeBadge.textContent = "已暂停 · 移开自动关";
      return;
    }
    const remainSec = Math.max(1, Math.ceil((noticeEndAt - Date.now()) / 1000));
    elements.noticeBadge.textContent = `${remainSec}秒自动关`;
  };
  updateBadge();
  noticeTickTimer = setInterval(updateBadge, 250);
  noticeCloseTimer = setTimeout(() => {
    closeNotice();
  }, ms);
}

function pauseNoticeOnHover() {
  if (!noticeOpen || noticeHovered) return;
  // 刚弹出来 150ms 内如果鼠标本来就停在半空没动，不算主动移上去
  if (Date.now() - noticeOpenedAt < 150) return;
  noticeHovered = true;
  clearNoticeTimers();
  if (elements.noticeBadge) {
    elements.noticeBadge.textContent = "已暂停 · 移开自动关";
  }
}

function resumeNoticeOnLeave() {
  if (!noticeOpen || !noticeHovered) return;
  noticeHovered = false;
  startNoticeCountdown(1500);
}

function showNotice(notice) {
  if (!notice || !elements.noticePanel) return;
  const hasActivePending = Boolean(
    activeInteractionEventId
    || snapshot.sessions?.some((item) => item.pendingInteraction && !dismissedInteractions.has(item.pendingInteraction.eventId)),
  );
  if (hasActivePending) return;
  clearNoticeTimers();
  openPanel("notice");
  const durationMs = Number(notice.durationMs) >= 1000 ? Number(notice.durationMs) : 6000;
  noticeHovered = false;
  noticeOpenedAt = Date.now();
  elements.noticeSource.textContent = notice.source || "系统提示";
  elements.noticeHeading.textContent = notice.title || "系统提示";
  elements.noticeExplanation.textContent = notice.body || "";
  elements.noticePanel.hidden = false;
  noticeOpen = true;
  syncPanelVisibility();
  startNoticeCountdown(durationMs);
}

function closeNotice() {
  clearNoticeTimers();
  noticeHovered = false;
  if (!noticeOpen) return;
  noticeOpen = false;
  if (elements.noticePanel) elements.noticePanel.hidden = true;
  syncPanelVisibility();
}

function noteNoticeTransitions(next) {
  const notice = next?.notice;
  if (!notice || !notice.noticeId) return;
  if (notice.noticeId === lastSeenNoticeId) return;
  lastSeenNoticeId = notice.noticeId;
  if (Date.now() - (notice.emittedAt || 0) > (notice.durationMs || 6000) + 4000) return;
  showNotice(notice);
}

function flushQueuedCompletion() {
  if (!queuedCompletion || !elements.interaction.hidden) return;
  const next = queuedCompletion;
  queuedCompletion = null;
  showCompletion(next);
}

function closeCompletion() {
  if (!completionOpen) return;
  completionOpen = false;
  elements.completionPanel.hidden = true;
  syncPanelVisibility();
}

function returnToAgentFromCompletion() {
  const target = completionTarget;
  if (target) window.agentPet.focusAgent(target);
  closeCompletion();
}

function noteCompletionTransitions(sessions) {
  if (!completionHydrated) {
    for (const session of sessions) lastSessionState.set(session.key, session.state);
    completionHydrated = true;
    return;
  }
  const seen = new Set();
  for (const session of sessions) {
    seen.add(session.key);
    const previous = lastSessionState.get(session.key);
    lastSessionState.set(session.key, session.state);
    if (session.state === "done" && previous !== "done") {
      celebrateCompletion();
      showCompletion(session);
    }
  }
  for (const key of [...lastSessionState.keys()]) {
    if (!seen.has(key)) lastSessionState.delete(key);
  }
}

// ===== 面板互斥调度口（治欠账 8 处，2026-08-12）=====
// 抽屉／设置／询问权限／完成弹窗四个面板互斥，开一个要关其他全部。
// 以前各家开面板时互相点名（drawer 调 pet 的、panel 调 drawer 的…），
// 现在统一来这里报「我要开了」，别的面板由底座收，谁也不再摸谁的家。

function openPanel(which) {
  if (which !== "drawer" && drawerOpen) closeDrawer();
  if (which !== "settings" && settingsOpen) closeSettings(false);
  if (which !== "completion" && completionOpen) closeCompletion();
  if (which !== "notice" && noticeOpen) closeNotice();
  if (which !== "interaction" && !elements.interaction.hidden) elements.interaction.hidden = true;
  syncPanelVisibility();
}

// 关掉任意面板后，把还挂着的待处理询问面板放回来（以前各家各写一份）
function restoreInteractionAfterPanelClose() {
  renderInteraction(snapshot.sessions.find((session) => session.pendingInteraction?.eventId === activeInteractionEventId));
}

// 面板开关会改幼苗姿态，统一走这里刷新（不让各面板直接摸 pet 内部）
function refreshPetPose() {
  updatePetPose();
}

// ===== 各 Agent 座位环境（v0.1.23 从「气泡条」改版，第三版：表情小人）=====
// 环境 = 像素教室背景图（assets/classroom.png，用户原型图），6 套工位就是 6 个座位（2026-10-01 从 9 座裁成 6 座，用户最多同时用 6 个）。
// 座位 = 椅子贴片（assets/seats/chair-0~8.png，从背景原位抠出贴回无缝）+ 坐在椅子上的小人 + 状态灯。
// 小人素材 = assets/avatars/<agent>.png，按状态分表情：
//   <agent>-working.png（干活） / <agent>-error.png（报错） / <agent>-done.png（开心完成） / <agent>-waiting.png（疑问）
//   回落顺序：<agent>-<state>.png → <agent>.png → 隐藏（只留椅子+状态灯，不崩）。
//   用户 2026-08-14 拍板：不要 CSS 像素小人占位，表情图用户自己提供。
// 灯色规矩沿用拍的板（状态灯保留，集成到表情之外仍亮着）：
//   绿 = 工作中 / 黄 = 休息中 / 红 = 卡顿·故障。
const SEAT_COUNT = 6;
const SEAT_STUCK_MS = 5 * 60 * 1000;
let seatSignature = null;

function seatStatus(session, now) {
  const lastSeen = session.lastSeenAt || session.updatedAt || now;
  const silent = now - lastSeen > SEAT_STUCK_MS;
  if (session.state === "error") return "stuck";
  if (session.state === "working" || session.state === "thinking" || session.state === "waiting") {
    return silent ? "stuck" : "working";
  }
  return "resting";
}

// 会话状态 → 表情素材后缀（用户 2026-08-14 定的四态）
const SEAT_EXPRESSION = {
  working: "working",
  thinking: "working",
  waiting: "waiting",
  done: "done",
  error: "error",
  idle: "",
};

// 小人头像路径：先找 <agent>-<状态>.png（如 pi-working.png）。回落链在 boot.js 的 error 委托：
//   <agent>-<状态>.png → <状态>.png（通用图，如 done.png）→ <agent>.png → 隐藏。
function seatAvatarPath(agent, state) {
  const expr = SEAT_EXPRESSION[state] || "";
  const agentPart = encodeURIComponent(agent);
  if (expr) return `assets/avatars/${agentPart}-${expr}.png`;
  return `assets/avatars/${agentPart}.png`;
}

function filledSeatHtml(session, now, index) {
  const status = seatStatus(session, now);
  const agentName = labels[session.agent] || session.agent;
  const project = session.project && session.project !== "未命名项目" ? session.project : "";
  const stateText = status === "stuck" ? "卡顿，5分钟没动静" : status === "working" ? "工作中" : "休息中";
  const tip = `${agentName} · ${stateText}${project ? ` · ${project}` : ""}`;
  return `<button class="seat seat-filled seat-pos-${index}" type="button" data-interactive
    data-agent="${escapeHtml(session.agent)}" data-project="${escapeHtml(project)}" data-origin-pid="${session.originPid || 0}"
    aria-label="${escapeHtml(tip)}" title="${escapeHtml(tip)}">
    <span class="seat-person" aria-hidden="true">
      <img class="seat-avatar" src="${escapeHtml(seatAvatarPath(session.agent, session.state))}"
        data-agent="${escapeHtml(session.agent)}" data-expr="${escapeHtml(SEAT_EXPRESSION[session.state] || "")}" data-step="0" alt="">
    </span>
  </button>`;
}

// 每次快照都调，但只在「哪几个会话 + 各自灯色」变了才重画 DOM——
// 干活时快照来得很快，每次都重建会让座位闪烁（用户视力不好，不许闪）。
// 会话按优先级排序后依次坐进 seat-pos-0~5；空工位不渲染（背景图里本来就有）。
function renderSeats(sessions) {
  const now = Date.now();
  const seatSessions = (sessions || []).slice(0, SEAT_COUNT);
  const signature = seatSessions.map((session) => `${session.key}:${seatStatus(session, now)}`).join("|") || "·empty";
  if (signature === seatSignature) return;
  seatSignature = signature;
  elements.agentSeats.innerHTML = seatSessions.map((session, index) => filledSeatHtml(session, now, index)).join("");
}

function renderSnapshot(next) {
  snapshot = next;
  const lead = next.sessions[0];
  let pending = activeInteractionEventId
    ? next.sessions.find((session) => session.pendingInteraction?.eventId === activeInteractionEventId)
    : undefined;
  if (!pending) pending = next.sessions.find((session) => session.pendingInteraction && !dismissedInteractions.has(session.pendingInteraction.eventId));
  const state = lead?.state || "idle";
  document.body.dataset.state = state;
  elements.statusAgent.textContent = lead ? (labels[lead.agent] || lead.agent) : "事件中心";
  elements.statusCopy.textContent = lead?.summary || stateCopy[state];
  elements.statusState.textContent = stateLabel[state];
  if ((state === "waiting" || state === "error") && celebrationTimer) {
    clearTimeout(celebrationTimer);
    celebrationTimer = null;
  }
  noteCompletionTransitions(next.sessions);
  noteNoticeTransitions(next);
  if (!celebrationTimer) updatePetPose();
  renderSessions(next.sessions);
  renderSeats(next.sessions);
  if (!interactionSubmitting) renderInteraction(pending);
  if (drawerOpen) renderDiagnostics();
}

// 询问／权限／完成面板和设置的窗口高度跟着内容走（2026-10-01）。
// 以前一律 740 高，这台机工作区才 778，一弹面板就挡住整条屏幕右边，下半截还是空的
// （面板开着时整个窗口收鼠标，透明的下半截也点不穿）。
// 事件抽屉照旧给满高（返回 null，主进程用默认值）。
const PANEL_TOP_BAND = 8;
const PANEL_BOTTOM_GAP = 20;
const INTERACTION_OPEN_GUARD_MS = 400;
let panelHeightSent = null;
let panelNeedsActionSent = false;
let panelFocusSent = false;
let interactionOpenedAt = 0;

/** 交互弹窗刚出现（或切换下一条）时记住时刻，前 400ms 拦截 1/2/3 与 Enter，防别的窗口正回车时误通过。 */
function markInteractionOpened(now = Date.now()) {
  interactionOpenedAt = now;
}

/** 是否还在弹窗刚出现的前 400ms 误触保护期内（Esc 不走这个保护，随时能关）。 */
function isInteractionQuickActionGuarded(now = Date.now()) {
  return interactionOpenedAt > 0 && now - interactionOpenedAt < INTERACTION_OPEN_GUARD_MS;
}

function panelFitHeight() {
  if (drawerOpen) return null;
  if (settingsOpen) return Math.ceil(elements.settings.offsetHeight + PANEL_TOP_BAND + PANEL_BOTTOM_GAP);
  const panel = !elements.interaction.hidden
    ? elements.interaction
    : completionOpen
      ? elements.completionPanel
      : noticeOpen
        ? elements.noticePanel
        : null;
  if (!panel) return null;
  let height = 2; // 面板上下边框
  for (const child of panel.children) {
    if (child.hidden) continue;
    height += child.classList.contains("interaction-scroll") ? naturalScrollHeight(child) : child.offsetHeight;
  }
  return Math.ceil(height + PANEL_TOP_BAND + PANEL_BOTTOM_GAP);
}

// 滚动区是 flex:1，会被撑到跟窗口一样高，直接读 scrollHeight 量到的是「窗口多高」不是「内容多高」。
// 179% 缩放下 Electron 每次定尺寸会多出 1 像素 → 量出来又高一点 → 再撑大，面板越开越高（2026-11-04）。
// 量之前临时取消撑开，读到的才是内容本身的高度。
function naturalScrollHeight(element) {
  const previous = element.style.flex;
  element.style.flex = "0 0 auto";
  const height = element.scrollHeight;
  element.style.flex = previous;
  return height;
}

function syncPanelVisibility() {
  const visible = drawerOpen || settingsOpen || completionOpen || noticeOpen || !elements.interaction.hidden;
  const height = visible ? panelFitHeight() : null;
  // 要他点的（询问／权限／完成／纯提示）露着没有：桌宠藏着时临时亮出来，点完或倒计时结束藏回去
  const needsAction = !elements.interaction.hidden || completionOpen || noticeOpen;
  // 只有需要键盘拍板的询问／权限面板露着时才置顶拿焦点，完成提醒与纯提示不抢正在打字的焦点
  const focusPanel = !elements.interaction.hidden;
  if (panelVisible === visible && panelHeightSent === height && panelNeedsActionSent === needsAction && panelFocusSent === focusPanel) return;
  panelVisible = visible;
  panelHeightSent = height;
  panelNeedsActionSent = needsAction;
  panelFocusSent = focusPanel;
  window.agentPet.setPanelVisibility(visible, height ?? undefined, needsAction, focusPanel);
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
