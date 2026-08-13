// 事件抽屉的界面侧：会话列表、按关键词查历史、连接诊断。
// 搜索走主进程的实时索引（events\event-index.ts），这儿只管画。

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
  openPanel("drawer");
  drawerOpen = true;
  elements.drawer.hidden = false;
  elements.interaction.hidden = true;
  refreshPetPose();
  renderDiagnostics();
  syncPanelVisibility();
}

function closeDrawer() {
  drawerOpen = false;
  elements.drawer.hidden = true;
  restoreInteractionAfterPanelClose();
  refreshPetPose();
}
