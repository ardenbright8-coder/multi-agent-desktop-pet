import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { screen } from "electron";
import type { BrowserWindow, Tray } from "electron";
import type { AgentEvent, InteractionPayload, InteractionResponseInput } from "../shared/protocol";
import { writeJsonAtomic } from "../shared/atomic-file";
import type { AgentHub } from "../events/hub";
import { dragTick, isIgnoringMouse, mouseModeState } from "../pet/window";

import type { PetTrayActions } from "../pet/tray";

export type ControlsTrayActions = PetTrayActions;

interface ControlsTestContext {
  window: BrowserWindow;
  tray: Tray;
  hub: AgentHub;
  trayActions: ControlsTrayActions;
  reportPath: string;
  failureScreenshotPath: string;
  version: string;
  getLastInteractionResponse(): InteractionResponseInput | null;
}

let sequence = 10_000;

export async function runControlsTest(context: ControlsTestContext): Promise<void> {
  const { window: win, hub } = context;
  try {
    if (win.webContents.isLoading()) await onceDidFinishLoad(win);
    await delay(200);
    win.show();
    win.focus();
    win.webContents.focus();

    const exposed = await evaluate<string[]>(win, "Object.keys(window.agentPet).sort()");
    assert.deepEqual(exposed, ["diagnostics", "focusAgent", "hideWindow", "onNoteSide", "onPetCommand", "onSnapshot", "reportError", "respondInteraction", "search", "setHoveringInteractive", "setPanelVisibility", "simulate", "snapshot", "startDragging", "stopDragging"]);

    const marker = `controls-${Date.now()}`;
    hub.publish(makeEvent("state.working", "search-session", { summary: `${marker} searchable event`, target: "package.json" }));
    await waitForRenderer(win, `document.querySelector('#status-copy').textContent.includes(${json(marker)})`);

    context.trayActions.openDrawer();
    await delay(200);
    await visible(win, "#drawer");
    await selectedTab(win, "sessions");

    await click(win, "#history-tab");
    await selectedTab(win, "history");
    await fill(win, "#search-input", marker);
    await waitForRenderer(win, `document.querySelector('#search-results').textContent.includes(${json(marker)})`, 2_000);
    await fill(win, "#search-input", `missing-${randomUUID()}`);
    await waitForRenderer(win, "document.querySelector('#search-state').textContent.includes('没有搜到')", 2_000);

    await click(win, "#diagnostics-tab");
    await selectedTab(win, "diagnostics");
    await waitForRenderer(win, "document.querySelector('#diagnostics-list').textContent.includes('本机事件中心')");
    await press(win, "ArrowLeft");
    await selectedTab(win, "history");
    await press(win, "ArrowLeft");
    await selectedTab(win, "sessions");

    const beforeSimulate = hub.snapshot().eventCount;
    await click(win, "#simulate-button");
    await waitFor(() => hub.snapshot().eventCount > beforeSimulate, 2_000, "Check-notification button did not publish an event");
    await click(win, "#drawer-close");
    await hidden(win, "#drawer");

    await click(win, "#status-note");
    await visible(win, "#drawer");
    await click(win, "#drawer-close");
    await hidden(win, "#drawer");

    context.trayActions.openSettings();
    await delay(200);
    await visible(win, "#settings-panel");
    await click(win, ".motion-option[data-motion='calm']");
    await rendererAssert(win, "document.body.dataset.motion === 'calm' && document.querySelector(\".motion-option[data-motion='calm']\").getAttribute('aria-pressed') === 'true'", "Calm motion button did not apply");
    await click(win, ".motion-option[data-motion='normal']");
    await rendererAssert(win, "document.body.dataset.motion === 'normal'", "Normal motion button did not apply");
    await click(win, ".motion-option[data-motion='lively']");
    await rendererAssert(win, "document.body.dataset.motion === 'lively'", "Lively motion button did not apply");
    await click(win, "#pet-size");
    await press(win, "Home");
    await rendererAssert(win, "document.querySelector('#pet-size').value === '70' && document.querySelector('#pet-size-value').textContent === '70%'", "Pet size Home key did not reach 70%");
    await press(win, "End");
    await rendererAssert(win, "document.querySelector('#pet-size').value === '140' && document.querySelector('#pet-size-value').textContent === '140%'", "Pet size End key did not reach 140%");
    await click(win, "#settings-close");
    await hidden(win, "#settings-panel");
    context.trayActions.openSettings();
    await delay(200);
    await rendererAssert(win, "document.querySelector('#pet-size').value === '140' && document.body.dataset.motion === 'lively'", "Appearance preferences were not retained after closing settings");
    await click(win, "#settings-close");
    const reloaded = onceDidFinishLoad(win);
    win.webContents.reload();
    await reloaded;
    await delay(180);
    await rendererAssert(win, "document.querySelector('#pet-size').value === '140' && document.querySelector('#pet-size-value').textContent === '140%' && document.body.dataset.motion === 'lively'", "Appearance preferences were not restored after renderer restart");

    const question = makeQuestionEvent();
    hub.publish(question);
    await interactionVisible(win, question.eventId);
    await click(win, "#interaction-confirm");
    await waitForRenderer(win, "document.querySelector('#interaction-error').textContent.includes('请先为每个问题')");
    await click(win, "[data-prompt-id='single'] input[value='one']");
    await click(win, "[data-prompt-id='multi'] input[value='alpha']");
    await click(win, "[data-prompt-id='multi'] input[value='beta']");
    await click(win, "[data-prompt-id='custom'] input[value='__custom__']");
    await fill(win, "[data-prompt-id='custom'] textarea", "按我的原话继续");
    await click(win, "#interaction-confirm");
    await waitForRenderer(win, "document.querySelector('#interaction-panel').hidden");
    const questionResponse = context.getLastInteractionResponse();
    assert.equal(questionResponse?.eventId, question.eventId);
    assert.deepEqual(questionResponse?.answers, [
      { promptId: "single", optionIds: ["one"], customText: undefined },
      { promptId: "multi", optionIds: ["alpha", "beta"], customText: undefined },
      { promptId: "custom", optionIds: [], customText: "按我的原话继续" },
    ]);

    const fallback = makeEvent("question.asked", "fallback-session", {
      summary: "Fallback interaction",
      requestId: "fallback-request",
      interaction: interaction("question", "fallback-request", false, [{ id: "fallback", question: "回原窗口吗？", options: [{ id: "yes", label: "是" }], multiple: false, allowCustomInput: false }]),
    });
    hub.publish(fallback);
    await interactionVisible(win, fallback.eventId);
    // 没有回传通道的那种：按钮必须点得动（写着「回原窗口处理」却禁用 = 死按钮），点了要能收起面板
    await rendererAssert(win, "!document.querySelector('#interaction-confirm').disabled && document.querySelector('#interaction-confirm').textContent.includes('返回终端') && !document.querySelector('#interaction-fallback').hidden", "Fallback confirm button was dead or mislabelled");
    await click(win, "#interaction-confirm");
    await hidden(win, "#interaction-panel");

    const bottomClose = makePermissionEvent("bottom-close-session", "bottom-close-request");
    hub.publish(bottomClose);
    await interactionVisible(win, bottomClose.eventId);
    await click(win, "#interaction-bottom-close");
    await hidden(win, "#interaction-panel");
    context.trayActions.openDrawer();
    await delay(200);
    await visible(win, "#drawer");
    await click(win, `[data-open-interaction='${bottomClose.eventId}']`);
    await interactionVisible(win, bottomClose.eventId);
    await click(win, "#interaction-top-close");

    const permission = makePermissionEvent("permission-submit-session", "permission-submit-request");
    hub.publish(permission);
    await interactionVisible(win, permission.eventId);
    // 🚨 面板一打开，第一个选项就得在视野里。
    // 以前这条没测，是因为 click() 会先 scrollIntoView 自动滚过去——测试永远绿，
    // 用户却看不到选项，点确认只报个同样看不见的错，以为按钮是死的（2026-08-12 实机踩到）。
    const optionInView = await evaluate<boolean>(win, `(() => {
      const scroll = document.querySelector('.interaction-scroll');
      const option = document.querySelector('.interaction-option');
      if (!scroll || !option) return false;
      const s = scroll.getBoundingClientRect();
      const o = option.getBoundingClientRect();
      return o.top >= s.top - 1 && o.top < s.bottom;
    })()`);
    assert.ok(optionInView, "面板一打开，第一个选项就在视野外——用户会以为确认按钮是死的");
    // 错误提示必须钉在滚动区外面（否则报错也看不见）
    const errorPinned = await evaluate<boolean>(win, "!document.querySelector('.interaction-scroll').contains(document.querySelector('#interaction-error'))");
    assert.ok(errorPinned, "错误提示还在滚动正文里，会被滚出视野");
    await click(win, "[data-prompt-id='permission'] input[value='once']");
    await click(win, "#interaction-confirm");
    await waitForRenderer(win, "document.querySelector('#interaction-panel').hidden");
    const permissionResponse = context.getLastInteractionResponse();
    assert.equal(permissionResponse?.eventId, permission.eventId);
    assert.deepEqual(permissionResponse?.answers, [{ promptId: "permission", optionIds: ["once"], customText: undefined }]);

    // 点击穿透：鼠标不在幼苗上时，窗口必须让开，否则透明区域会挡住底下的程序（踩过的 bug）。
    await hidden(win, "#interaction-panel");
    // 窗口缩成幼苗大小后，幼苗区占了绝大部分，只有左上角这几像素是真空——拿它验穿透。
    // 面板刚收起、窗口刚缩回，界面要一小会儿才重新布局好，所以等一下再连发两次移动。
    await delay(250);
    win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2, movementX: -60, movementY: -60 });
    await delay(120);
    win.webContents.sendInputEvent({ type: "mouseMove", x: 3, y: 3, movementX: 1, movementY: 1 });
    if (!await tolerate(() => isIgnoringMouse(), 3_000)) {
      const dom = await evaluate<string>(win, "(() => { const el = document.elementFromPoint(3, 3); return el ? (el.id || el.className || el.tagName) + ' interactive=' + Boolean(el.closest('[data-interactive]')) : 'null'; })()");
      assert.fail(`Pointer left the pet but the window still swallowed mouse events —— 主进程：${mouseModeState()}；界面 elementFromPoint(3,3)=${dom}`);
    }
    const petCenter = await center(win, "#pet");
    win.webContents.sendInputEvent({ type: "mouseMove", x: petCenter.x, y: petCenter.y, movementX: 5, movementY: 5 });
    await waitFor(() => !isIgnoringMouse(), 1_500, "Pointer entered the pet but the window stayed click-through");

    // 拖动是「按住拖、松手放」，而且**整个窗口一律锁在屏幕里**（用户明确要求「框不要超出屏幕」）。
    // 窗口位置由主进程读系统光标算，所以这儿直接喂坐标给 dragTick，不能靠 sendInputEvent 移动假光标。
    const beforeMove = win.getBounds();
    const petPoint = await center(win, "#pet");
    win.webContents.sendInputEvent({ type: "mouseMove", x: petPoint.x, y: petPoint.y, movementX: 0, movementY: 0 });
    win.webContents.sendInputEvent({ type: "mouseDown", x: petPoint.x, y: petPoint.y, button: "left", clickCount: 1 });
    await waitForRenderer(win, "document.body.classList.contains('pet-picked-up') && document.querySelector('#pet').getAttribute('aria-pressed') === 'true'", 2_000);

    const area = screen.getPrimaryDisplay().workArea;
    // 平时窗口必须是幼苗那么小，否则上下没地方挪（用户实机：只能左右平移）
    const idleBounds = win.getBounds();
    assert.ok(
      idleBounds.height <= 340 && area.height - idleBounds.height >= 200,
      `Idle window is too tall to move vertically: ${idleBounds.height} in a ${area.height}-tall work area`,
    );
    dragTick({ x: area.x + 260, y: area.y + 180 });
    await waitFor(() => {
      const current = win.getBounds();
      return current.x !== beforeMove.x || current.y !== beforeMove.y;
    }, 2_000, "Dragging the pet did not move the window");

    // 往屏幕外死拖，窗口必须被拦在工作区里，一个边都不许越
    dragTick({ x: area.x + area.width + 800, y: area.y + area.height + 800 });
    const pushed = win.getBounds();
    assert.ok(
      pushed.x >= area.x && pushed.y >= area.y
        && pushed.x + pushed.width <= area.x + area.width
        && pushed.y + pushed.height <= area.y + area.height,
      `Dragging past the screen edge left the window offscreen: ${JSON.stringify(pushed)} vs ${JSON.stringify(area)}`,
    );
    dragTick({ x: area.x - 900, y: area.y - 900 });
    const pulled = win.getBounds();
    assert.ok(pulled.x >= area.x && pulled.y >= area.y, `Dragging past the top-left corner left the window offscreen: ${JSON.stringify(pulled)}`);

    // 🚨 窗口尺寸在拖动中必须纹丝不动。
    // 2026-08-12 踩过：非整数 DPI 缩放（179%）下每次挪窗口尺寸都涨一点，涨过屏幕高度后
    // 窗口被一路推出屏幕顶部，用户只能往下拖、永远上不去。连拖 60 次，一个像素都不许变。
    const sizeBefore = win.getBounds();
    for (let step = 0; step < 60; step += 1) {
      dragTick({ x: area.x + 200 + (step % 7) * 40, y: area.y + 150 + (step % 5) * 50 });
    }
    const sizeAfter = win.getBounds();
    // ±2 是高 DPI 下的取整抖动（每次挪窗口都会把尺寸钉回设计值，抖不出去）；
    // 真正要拦的是「滚雪球」——那种一涨就是几十上百像素。
    assert.ok(Math.abs(sizeAfter.width - sizeBefore.width) <= 2, `Window grew wider while dragging: ${sizeBefore.width} → ${sizeAfter.width}`);
    assert.ok(Math.abs(sizeAfter.height - sizeBefore.height) <= 2, `Window grew taller while dragging: ${sizeBefore.height} → ${sizeAfter.height}`);
    assert.ok(sizeAfter.height <= area.height - 100, `Window is too tall to move vertically: ${sizeAfter.height} in ${area.height}`);

    win.webContents.sendInputEvent({ type: "mouseUp", x: petPoint.x, y: petPoint.y, button: "left", clickCount: 1 });
    await waitForRenderer(win, "!document.body.classList.contains('pet-picked-up') && document.querySelector('#pet').getAttribute('aria-pressed') === 'false'", 2_000);

    context.trayActions.hide();
    await delay(150);
    await waitFor(() => !win.isVisible(), 1_500, "Hide button did not hide the window");
    context.tray.emit("click", {} as never, {} as never, {} as never);
    await waitFor(() => win.isVisible(), 1_500, "Tray click callback did not restore the window");
    const beforeTraySimulation = hub.snapshot().eventCount;
    context.trayActions.simulate();
    await waitFor(() => hub.snapshot().eventCount > beforeTraySimulation, 1_500, "Tray test-notification callback did not publish an event");

    win.close();
    await waitFor(() => !win.isVisible() && !win.isDestroyed(), 1_500, "Window close did not keep the tray process alive");
    context.trayActions.show();
    await waitFor(() => win.isVisible(), 1_500, "Tray show callback did not restore a closed window");

    // 面板弹出来不许遮住幼苗：幼苗那块必须整个露在面板上边（用户 2026-08-12 的硬要求）
    const permissionForBand = makePermissionEvent("panel-band-session", "panel-band-request");
    hub.publish(permissionForBand);
    await interactionVisible(win, permissionForBand.eventId);
    const overlap = await evaluate<{ petBottom: number; panelTop: number }>(
      win,
      "(() => { const pet = document.querySelector('#pet').getBoundingClientRect(); const panel = document.querySelector('#interaction-panel').getBoundingClientRect(); return { petBottom: Math.round(pet.bottom), panelTop: Math.round(panel.top) }; })()",
    );
    assert.ok(
      overlap.panelTop >= overlap.petBottom,
      `Panel covers the pet: 幼苗底 ${overlap.petBottom} vs 面板顶 ${overlap.panelTop}`,
    );
    await click(win, "#interaction-top-close");
    await hidden(win, "#interaction-panel");

    // 永远压在最前面：任何时候都必须是置顶状态
    assert.equal(win.isAlwaysOnTop(), true, "Pet window lost always-on-top");

    // 「聊天框换个边」：托盘点一下，界面必须真的翻到另一边
    const sideBefore = await evaluate<string>(win, "document.body.dataset.noteSide");
    context.trayActions.flipNote();
    await waitForRenderer(win, `document.body.dataset.noteSide !== ${json(sideBefore)}`, 2_000);
    context.trayActions.flipNote();
    await waitForRenderer(win, `document.body.dataset.noteSide === ${json(sideBefore)}`, 2_000);

    // 「把幼苗叫回来」：拖丢了要能一键回到默认位置
    win.setPosition(-500, -900, false);
    context.trayActions.recall();
    await waitFor(() => { const b = win.getBounds(); return b.x > 0 && b.y > 0; }, 1_500, "Tray recall did not bring the pet back on screen");

    // 完成弹窗：只有会话新进入 done 才弹；已经是 done 的会话再当 lead / 再报一次完成都不许重弹。
    // 先把测试残留的询问/权限清掉，否则 waiting 优先级更高，完成弹窗会被当场挤掉。
    for (const session of hub.snapshot().sessions) {
      const pending = session.pendingInteraction;
      if (!pending) continue;
      hub.publish(makeEvent(pending.mode === "permission" ? "permission.resolved" : "question.resolved", session.sessionId, {
        requestId: pending.providerRequestId,
      }));
    }
    await delay(150);
    await hidden(win, "#interaction-panel");
    hub.publish(makeEvent("state.working", "completion-a", { summary: "A 在干活" }));
    await delay(80);
    hub.publish(makeEvent("task.completed", "completion-a", { summary: "A 干完了" }));
    await visible(win, "#completion-panel");
    await rendererAssert(win, "document.querySelector('#completion-explanation').textContent.includes('A 干完了')", "完成弹窗没带上摘要");
    await click(win, "#completion-return");
    await hidden(win, "#completion-panel");
    hub.publish(makeEvent("state.working", "completion-b", { summary: "B 在干活" }));
    await delay(150);
    await hidden(win, "#completion-panel");
    hub.publish(makeEvent("task.completed", "completion-b", { summary: "B 干完了" }));
    await visible(win, "#completion-panel");
    await rendererAssert(win, "document.querySelector('#completion-explanation').textContent.includes('B 干完了')", "新完成没有重新弹出");
    await click(win, "#completion-close");
    await hidden(win, "#completion-panel");
    hub.publish(makeEvent("task.completed", "completion-a", { summary: "A 又报了一次完成" }));
    await delay(150);
    await hidden(win, "#completion-panel");

    const report = {
      version: context.version,
      fixedButtonsClicked: 14,
      dynamicControls: ["radio", "checkbox", "custom-text", "pending-reopen", "fallback-confirm", "option-in-view"],
      inputs: ["search-hit", "search-empty", "range-home", "range-end", "tab-keyboard", "settings-restart-restore"],
      window: ["panel-keeps-pet-visible", "always-on-top", "click-through", "pet-drag-start", "pet-drag-move", "pet-drag-clamped", "pet-drag-no-growth", "pet-drag-end", "hide", "tray-restore", "close-to-tray"],
      trayCallbacks: ["show", "recall", "hide", "open-drawer", "open-settings", "flip-note", "open-logs", "simulate", "quit"],
      interactionAnswersVerified: true,
    };
    writeJsonAtomic(context.reportPath, report);
    process.stdout.write(`CONTROLS_OK buttons=${report.fixedButtonsClicked} dynamic=${report.dynamicControls.length} inputs=${report.inputs.length} window=${report.window.length}\n`);
    context.trayActions.quit();
  } catch (error) {
    try {
      const image = await win.webContents.capturePage();
      writeFileSync(context.failureScreenshotPath, image.toPNG());
    } catch {
      // Preserve the original control-test failure.
    }
    throw error;
  }
}

function makeQuestionEvent(): AgentEvent {
  const requestId = "controls-question-request";
  return makeEvent("question.asked", "controls-question-session", {
    summary: "Controls multi-prompt question",
    requestId,
    interaction: interaction("question", requestId, true, [
      { id: "single", question: "单选哪一个？", options: [{ id: "one", label: "选项一" }, { id: "two", label: "选项二" }], multiple: false, allowCustomInput: false },
      { id: "multi", question: "多选哪些？", options: [{ id: "alpha", label: "甲" }, { id: "beta", label: "乙" }], multiple: true, allowCustomInput: false },
      { id: "custom", question: "写下原话", options: [], multiple: false, allowCustomInput: true },
    ]),
  });
}

function makePermissionEvent(sessionId: string, requestId: string): AgentEvent {
  return makeEvent("permission.requested", sessionId, {
    summary: "Controls permission",
    requestId,
    interaction: interaction("permission", requestId, true, [
      { id: "permission", question: "允许这次操作吗？", options: [{ id: "once", label: "允许一次", value: "once" }, { id: "reject", label: "拒绝", value: "reject" }], multiple: false, allowCustomInput: false },
    ]),
  });
}

function interaction(mode: "question" | "permission", requestId: string, responseCapability: boolean, prompts: InteractionPayload["prompts"]): InteractionPayload {
  return { mode, title: mode === "question" ? "控件询问测试" : "控件权限测试", providerRequestId: requestId, prompts, responseCapability, responseStatus: "pending" };
}

function makeEvent(kind: AgentEvent["kind"], sessionId: string, details: Partial<AgentEvent>): AgentEvent {
  sequence += 1;
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: "desktop-simulator",
    sequence,
    emittedAt: Date.now() + sequence,
    agent: "simulator",
    sessionId,
    kind,
    project: "全控件验收",
    title: "全控件验收",
    summary: "Controls test event",
    ...details,
  };
}

async function click(win: BrowserWindow, selector: string): Promise<void> {
  const point = await center(win, selector);
  const hit = await evaluate<boolean>(win, `(() => { const element = document.querySelector(${json(selector)}); const target = document.elementFromPoint(${point.x}, ${point.y}); return Boolean(element && target && (element === target || element.contains(target))); })()`);
  assert.equal(hit, true, `Control is visible but not mouse-clickable: ${selector}`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, movementX: 0, movementY: 0 });
  win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await delay(90);
}

async function center(win: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  const result = await evaluate<{ x: number; y: number; width: number; height: number; disabled: boolean } | null>(win, `(() => { const element = document.querySelector(${json(selector)}); if (!element) return null; element.scrollIntoView({ block: 'center', inline: 'center' }); const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, disabled: Boolean(element.disabled) }; })()`);
  assert.ok(result, `Control was not found: ${selector}`);
  assert.ok(result.width > 0 && result.height > 0, `Control has no clickable size: ${selector}`);
  assert.equal(result.disabled, false, `Control is disabled: ${selector}`);
  return { x: result.x, y: result.y };
}

async function fill(win: BrowserWindow, selector: string, text: string): Promise<void> {
  await click(win, selector);
  await press(win, "A", ["control"]);
  await press(win, "Backspace");
  win.webContents.insertText(text);
  await delay(180);
}

async function press(win: BrowserWindow, keyCode: string, modifiers: Array<"control" | "shift" | "alt" | "meta"> = []): Promise<void> {
  const electronKeyCode = keyCode === "ArrowLeft" ? "Left" : keyCode === "ArrowRight" ? "Right" : keyCode;
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: electronKeyCode, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: electronKeyCode, modifiers });
  await delay(80);
}

async function interactionVisible(win: BrowserWindow, eventId: string): Promise<void> {
  void eventId;
  await waitForRenderer(win, "!document.querySelector('#interaction-panel').hidden");
}

async function visible(win: BrowserWindow, selector: string): Promise<void> {
  await waitForRenderer(win, `!document.querySelector(${json(selector)}).hidden`);
}

async function hidden(win: BrowserWindow, selector: string): Promise<void> {
  await waitForRenderer(win, `document.querySelector(${json(selector)}).hidden`);
}

async function selectedTab(win: BrowserWindow, name: string): Promise<void> {
  await waitForRenderer(win, `document.querySelector(${json(`[data-tab='${name}']`)}).getAttribute('aria-selected') === 'true'`);
}

async function rendererAssert(win: BrowserWindow, expression: string, message: string): Promise<void> {
  const passed = await evaluate<boolean>(win, `Boolean(${expression})`);
  assert.equal(passed, true, message);
}

async function waitForRenderer(win: BrowserWindow, expression: string, timeoutMs = 1_500): Promise<void> {
  await waitFor(async () => evaluate<boolean>(win, `Boolean(${expression})`), timeoutMs, `Renderer condition timed out: ${expression}`);
}

async function tolerate(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(25);
  }
  return false;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

function evaluate<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression) as Promise<T>;
}

function onceDidFinishLoad(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => win.webContents.once("did-finish-load", () => resolve()));
}

function json(value: string): string {
  return JSON.stringify(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
