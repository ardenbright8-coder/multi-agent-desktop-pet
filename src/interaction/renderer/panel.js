// 询问／权限面板的界面侧：怎么画、怎么收答案、怎么交回 Agent。
// 面板文字一律来自事件本身（主进程 interaction\presenter.ts 生成），这儿不许写死任何一句说明。

// 输入框里粘进来的图（2026-11-04）：存进 24 小时临时夹，交回时在附言后面带上「附图：位置」，AI 自己打开看。
let panelImages = []; // { path, url }
let panelImageSaves = [];

function isDirectSingleChoice(pending) {
  return Boolean(
    pending
    && pending.responseCapability
    && Array.isArray(pending.prompts)
    && pending.prompts.length === 1
    && !pending.prompts[0].multiple
    && Array.isArray(pending.prompts[0].options)
    && pending.prompts[0].options.length > 0
  );
}

function renderInteraction(session) {
  const pending = session?.pendingInteraction;
  const wasHidden = elements.interaction.hidden;
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
  if (wasHidden || !samePending) {
    markInteractionOpened();
    if (document.activeElement instanceof HTMLElement && !elements.interaction.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }
  const directSingle = isDirectSingleChoice(pending);
  elements.interaction.classList.toggle("direct-single", directSingle);
  const actions = document.querySelector("#interaction-actions");
  if (actions) actions.hidden = directSingle;
  const helpPopover = document.querySelector("#interaction-help-popover");
  if (helpPopover && !samePending) helpPopover.hidden = true;
  document.querySelector("#interaction-agent").textContent = labels[session.agent] || session.agent;
  const type = document.querySelector("#interaction-type");
  type.textContent = pending.mode === "question" ? "询问" : "权限";
  type.className = `type-badge ${pending.mode}`;
  const queueBadge = document.querySelector("#interaction-queue");
  if (queueBadge) {
    const pendingList = snapshot.sessions.filter(
      (item) => item.pendingInteraction && !dismissedInteractions.has(item.pendingInteraction.eventId),
    );
    if (pendingList.length > 1) {
      const idx = Math.max(0, pendingList.findIndex((item) => item.pendingInteraction?.eventId === pending.eventId)) + 1;
      queueBadge.textContent = `${idx}/${pendingList.length}`;
      queueBadge.hidden = false;
    } else {
      queueBadge.hidden = true;
    }
  }
  document.querySelector("#interaction-heading").textContent = pending.title;
  document.querySelector("#interaction-explanation").textContent = pending.explanation;
  // 同一个弹窗（eventId 没变）时不重建选项/输入区——每次快照都重建的话，
  // 用户在“自己输入”里打的字会被清掉（2026-08-13 实机：输 1234 过一会就没了，
  // 其实是别的窗口状态事件一进来就把整个面板重画了）。
  if (!samePending) {
    panelImages = [];
    panelImageSaves = [];
    elements.interactionPrompts.innerHTML = pending.prompts.map((prompt, index) => renderPrompt(prompt, index, directSingle)).join("");
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

function renderPrompt(prompt, promptIndex, directSingle = false) {
  if (directSingle) {
    const hasRec = prompt.options.some((o) => o.recommended);
    const options = `<div class="interaction-options-row">${prompt.options.map((option, idx) => {
      const isRec = option.recommended || (!hasRec && idx === 0);
      const isDanger = option.id === "reject" || /拒绝|不准|deny|reject/i.test(option.label);
      return `
        <label class="interaction-option pill-option${isRec ? " recommended" : ""}${isDanger ? " danger" : ""}" title="${escapeHtml(option.description || option.label)}">
          <input type="radio" name="prompt-${promptIndex}" value="${escapeHtml(option.id)}" data-direct-option="1" />
          <span><strong>${escapeHtml(option.label)}</strong></span>
        </label>
      `;
    }).join("")}</div>`;
    const custom = prompt.allowCustomInput ? `
      <textarea class="compact-custom-input" data-custom-input="${escapeHtml(prompt.id)}" rows="1" placeholder="${prompt.id === "permission" ? "可写句话带给 AI，按 Enter＝允许一次" : "或直接写你的话，按 Enter 交回…"}"></textarea>
    ` : "";
    return `<fieldset class="interaction-prompt" data-prompt-id="${escapeHtml(prompt.id)}"><legend>${escapeHtml(prompt.question)}</legend>${options}${custom}</fieldset>`;
  }
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
    <textarea data-custom-input="${escapeHtml(prompt.id)}" rows="2" placeholder="写下你的做法、限制或回答"></textarea>
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
  if (!next && typeof flushQueuedCompletion === "function") flushQueuedCompletion();
}

async function submitInteraction() {
  const session = currentInteractionSession();
  const pending = session?.pendingInteraction;
  if (!session || !pending || interactionSubmitting) return;
  // 这家 Agent 没有回传通道：按钮的意思就是「我知道了，去终端办」，先通知主进程切终端并跳过还焦点，再收起面板。
  if (!pending.responseCapability) {
    const target = { agent: session.agent, project: session.project, originPid: session.originPid };
    window.agentPet.focusAgent(target);
    dismissInteraction();
    return;
  }
  const directSingle = isDirectSingleChoice(pending);
  // 图还在存就等它存完，免得点得快把图丢了
  if (panelImageSaves.length) await Promise.allSettled(panelImageSaves);
  const imageLines = panelImages.map((image) => `附图：${image.path}`).join("\n");
  let imagesAttached = false;
  const answers = [];
  for (const prompt of pending.prompts) {
    const fieldset = elements.interactionPrompts.querySelector(`[data-prompt-id="${cssEscape(prompt.id)}"]`);
    const selected = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
    let customText = fieldset.querySelector("textarea")?.value.trim() || "";
    if (imageLines && !imagesAttached && fieldset.querySelector("textarea")) {
      customText = [customText, imageLines].filter(Boolean).join("\n");
      imagesAttached = true;
    }
    const optionIds = selected.filter((value) => value !== "__custom__");
    // 权限窗按 Enter（没点按钮）＝默认允许一次，写了字就当附言一起带上（2026-11-04 他定）。
    // 只有开头就是「不／别／拒绝／no」这类的，还按原来的算没批准、原话交回。
    const sayNo = /^\s*(不|别|拒绝|否|no\b|nope|deny|reject)/i.test(customText);
    const enterAllows = pending.mode === "permission" && !sayNo;
    if (!optionIds.length && (!customText || enterAllows) && directSingle && prompt.options?.length) {
      const def = prompt.options.find((o) => o.recommended) || prompt.options[0];
      if (def?.id) optionIds.push(def.id);
    }
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

// ═══ 他正在用这个窗：倒计时停住（2026-11-04 他要的）═══
// 鼠标在窗上，或光标在输入框里闪着（窗口有焦点），每 2 秒告诉桌宠一声；
// 钩子那边看到就不往下数，手离开后再从头数 1 分钟。
// 鼠标在不在用 :hover 现查，不自己记——鼠标甩出窗口时 mouseleave 可能漏发，自己记的会一直当它还在。
function interactionInUse() {
  if (elements.interaction.hidden || !activeInteractionEventId) return false;
  const typing = document.hasFocus() && document.activeElement instanceof HTMLTextAreaElement && elements.interaction.contains(document.activeElement);
  return typing || elements.interaction.matches(":hover");
}
function reportInteractionHeld() {
  if (interactionInUse()) window.agentPet.holdInteraction(activeInteractionEventId);
}
elements.interaction.addEventListener("mouseenter", reportInteractionHeld);
elements.interaction.addEventListener("focusin", reportInteractionHeld);
elements.interaction.addEventListener("input", reportInteractionHeld);
setInterval(reportInteractionHeld, 2_000);

// ═══ 输入框粘图 / 拖图 ═══
function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  if (typeof file.name === "string" && /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) return true;
  return false;
}

function addPanelImageFile(file, textarea) {
  if (!isImageFile(file)) return;
  const save = new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const url = String(reader.result || "");
      const path = await window.agentPet.savePanelImage(url).catch(() => null);
      if (path) {
        const previewUrl = url.startsWith("data:image/") ? url : `file:///${path.replace(/\\/g, "/")}`;
        panelImages.push({ path, url: previewUrl });
        renderPanelImages(textarea);
      } else {
        showInteractionError("这张图存不下来（太大或格式不认），换一张试试。");
      }
      resolve();
    };
    reader.onerror = () => resolve();
    reader.readAsDataURL(file);
  });
  panelImageSaves.push(save);
}

function addPanelClipboardImage(textarea) {
  const save = (async () => {
    const path = await window.agentPet.savePanelImage("clipboard").catch(() => null);
    if (path) {
      const previewUrl = `file:///${path.replace(/\\/g, "/")}`;
      panelImages.push({ path, url: previewUrl });
      renderPanelImages(textarea);
    }
  })();
  panelImageSaves.push(save);
}

function renderPanelImages(textarea) {
  const fieldset = textarea?.closest("fieldset") || elements.interactionPrompts.querySelector("fieldset");
  if (!fieldset) return;
  let strip = fieldset.querySelector(".panel-images");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "panel-images";
    fieldset.appendChild(strip);
  }
  strip.innerHTML = panelImages.map((image, index) => `
    <span class="panel-image" title="${escapeHtml(image.path)}">
      <img src="${escapeHtml(image.url)}" alt="附图 ${index + 1}" />
      <button type="button" class="panel-image-remove" data-remove-image="${index}" aria-label="去掉这张图">×</button>
    </span>`).join("");
  strip.hidden = panelImages.length === 0;
  syncPanelVisibility();
}

function isClipboardImagePathText(text) {
  const trimmed = String(text || "").trim().replace(/^["']|["']$/g, "");
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  return /^(?:[a-zA-Z]:[\\/]|\\\\)[^\r\n]+\.(?:png|jpe?g|webp|gif|bmp)$/i.test(trimmed);
}

let lastPasteEventAt = 0;

// 弹窗开着但还没点进输入框时按 Ctrl+V，先把焦点送到输入框，接住原生粘贴；
// 若纯图片剪贴板或刚切焦点导致 Chromium 没派发 paste 事件，60ms 后直接从系统剪贴板读图兜底。
document.addEventListener("keydown", (event) => {
  if (elements.interaction.hidden) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key || "").toLowerCase() === "v") {
    const textarea = elements.interactionPrompts.querySelector("textarea");
    if (!textarea) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) {
      textarea.focus();
    }
    const downAt = Date.now();
    setTimeout(() => {
      if (lastPasteEventAt < downAt && !elements.interaction.hidden) {
        addPanelClipboardImage(textarea);
      }
    }, 60);
  }
});

document.addEventListener("paste", (event) => {
  if (elements.interaction.hidden) return;
  lastPasteEventAt = Date.now();
  const target = event.target instanceof HTMLTextAreaElement && elements.interactionPrompts.contains(event.target)
    ? event.target
    : elements.interactionPrompts.querySelector("textarea");
  if (!target) return;
  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const rawFiles = [...(event.clipboardData?.files || [])];
  const files = (itemFiles.length ? itemFiles : rawFiles).filter(isImageFile);
  if (files.length) {
    event.preventDefault();
    for (const file of files) addPanelImageFile(file, target);
    return;
  }
  const plainText = event.clipboardData?.getData?.("text/plain") || "";
  if (!plainText || isClipboardImagePathText(plainText)) {
    event.preventDefault();
    addPanelClipboardImage(target);
  }
});
elements.interaction.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) event.preventDefault();
});
elements.interaction.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])].filter(isImageFile);
  if (!files.length) return;
  event.preventDefault();
  const textarea = elements.interactionPrompts.querySelector("textarea");
  for (const file of files) addPanelImageFile(file, textarea);
});
elements.interactionPrompts.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-remove-image]") : null;
  if (!button) return;
  event.stopPropagation();
  panelImages.splice(Number(button.dataset.removeImage), 1);
  renderPanelImages(button.closest("fieldset")?.querySelector("textarea"));
});
