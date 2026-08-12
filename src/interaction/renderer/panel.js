// 询问／权限面板的界面侧：怎么画、怎么收答案、怎么交回 Agent。
// 面板文字一律来自事件本身（主进程 interaction\presenter.ts 生成），这儿不许写死任何一句说明。

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
