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
  const samePending = pending.eventId === activeInteractionEventId;
  activeInteractionEventId = pending.eventId;
  openPanel("interaction");
  elements.interaction.hidden = false;
  document.querySelector("#interaction-agent").textContent = labels[session.agent] || session.agent;
  const type = document.querySelector("#interaction-type");
  type.textContent = pending.mode === "question" ? "询问" : "权限";
  type.className = `type-badge ${pending.mode}`;
  document.querySelector("#interaction-heading").textContent = pending.title;
  document.querySelector("#interaction-explanation").textContent = pending.explanation;
  // 同一个弹窗（eventId 没变）时不重建选项/输入区——每次快照都重建的话，
  // 用户在“自己输入”里打的字会被清掉（2026-08-13 实机：输 1234 过一会就没了，
  // 其实是别的窗口状态事件一进来就把整个面板重画了）。
  if (!samePending) {
    elements.interactionPrompts.innerHTML = pending.prompts.map(renderPrompt).join("");
  }
  const fallback = document.querySelector("#interaction-fallback");
  fallback.hidden = pending.responseCapability;
  // 不支持回传时按钮写着「回原窗口处理」，那它就得点得动——点了把面板收起来，人回终端去办。
  // 以前这里连按钮一起禁用，写着字却点不动，等于摆了个死按钮（2026-08-12 实机踩的，也违反 D-06「不放假按钮」）。
  elements.interactionConfirm.disabled = pending.responseCapability
    ? (pending.prompts.length === 0 || pending.responseStatus === "submitting")
    : false;
  elements.interactionConfirm.textContent = pending.responseCapability ? (pending.responseStatus === "submitting" ? "正在交回…" : "确认") : "知道了，返回终端";
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
  advanceToNextPending();
}

function openInteraction(session) {
  openPanel("interaction");
  const eventId = session.pendingInteraction.eventId;
  dismissedInteractions.delete(eventId);
  activeInteractionEventId = eventId;
  renderInteraction(session);
}

/** 处理完/关掉当前待处理项后，自动把下一个未处理、没被关掉的弹出来（2026-08-13 排队逐个处理）。
 *  以前收掉当前面板就等下一次快照，没新事件就一直不弹下一个——多个窗口同时等你时，
 *  你只看到第一个，其余像“没弹窗”。现在处理完一个立刻找下一个，像批文件一样逐个过。 */
function advanceToNextPending() {
  const next = snapshot.sessions.find((session) => session.pendingInteraction && !dismissedInteractions.has(session.pendingInteraction.eventId));
  renderInteraction(next);
}

async function submitInteraction() {
  const session = currentInteractionSession();
  const pending = session?.pendingInteraction;
  if (!session || !pending || interactionSubmitting) return;
  // 这家 Agent 没有回传通道：按钮的意思就是「我知道了，去终端办」，收起面板即可。
  if (!pending.responseCapability) {
    const target = { agent: session.agent, project: session.project, originPid: session.originPid };
    dismissInteraction();
    window.agentPet.focusAgent(target);
    return;
  }
  const answers = [];
  for (const prompt of pending.prompts) {
    const fieldset = elements.interactionPrompts.querySelector(`[data-prompt-id="${cssEscape(prompt.id)}"]`);
    const selected = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
    const customText = fieldset.querySelector("textarea")?.value.trim() || "";
    const optionIds = selected.filter((value) => value !== "__custom__");
    // 写了字就算自己填，不必先点「自己输入」那个圈。对照 Clawd Other 文本框：有字就能提交。
    if (!optionIds.length && !customText) {
      showInteractionError("请先为每个问题选择一项，或写下自己的回答。");
      // 把没选的那题滚到眼前——面板矮的时候选项可能在视野外，
      // 不滚过去用户只会觉得「点了没反应」（2026-08-12 实机踩到）。
      fieldset?.scrollIntoView({ block: "center" });
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
    advanceToNextPending();
    return;
  }
  // 交不回去就别卡在面板上让人再点——收起并切回原窗口。
  // 以前会留下「请回原窗口处理」这种看不懂的红字，人以为按钮坏了（2026-08-13）。
  dismissedInteractions.add(pending.eventId);
  activeInteractionEventId = null;
  advanceToNextPending();
  window.agentPet.focusAgent({ agent: session.agent, project: session.project, originPid: session.originPid });
}

function showInteractionError(message) {
  elements.interactionError.hidden = !message;
  elements.interactionError.textContent = message;
}
