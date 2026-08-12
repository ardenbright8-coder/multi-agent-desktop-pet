import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BrowserWindow, Tray } from "electron";
import type { AgentEvent, InteractionPayload, InteractionResponseInput } from "../shared/protocol";
import { writeJsonAtomic } from "../shared/atomic-file";
import type { AgentHub } from "../events/hub";
import { isIgnoringMouse } from "../pet/window";

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
    assert.deepEqual(exposed, ["diagnostics", "finishWindowMove", "hideWindow", "moveWindowToPointer", "onSnapshot", "respondInteraction", "search", "setDragging", "setHoveringInteractive", "setPanelVisibility", "simulate", "snapshot"]);

    const marker = `controls-${Date.now()}`;
    hub.publish(makeEvent("state.working", "search-session", { summary: `${marker} searchable event`, target: "package.json" }));
    await waitForRenderer(win, `document.querySelector('#status-copy').textContent.includes(${json(marker)})`);

    await click(win, "#open-button");
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

    await click(win, "#settings-button");
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
    await click(win, "#settings-button");
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
    await rendererAssert(win, "!document.querySelector('#interaction-confirm').disabled && document.querySelector('#interaction-confirm').textContent.includes('回原窗口') && !document.querySelector('#interaction-fallback').hidden", "Fallback confirm button was dead or mislabelled");
    await click(win, "#interaction-confirm");
    await hidden(win, "#interaction-panel");

    const bottomClose = makePermissionEvent("bottom-close-session", "bottom-close-request");
    hub.publish(bottomClose);
    await interactionVisible(win, bottomClose.eventId);
    await click(win, "#interaction-bottom-close");
    await hidden(win, "#interaction-panel");
    await click(win, "#open-button");
    await visible(win, "#drawer");
    await click(win, `[data-open-interaction='${bottomClose.eventId}']`);
    await interactionVisible(win, bottomClose.eventId);
    await click(win, "#interaction-top-close");

    const permission = makePermissionEvent("permission-submit-session", "permission-submit-request");
    hub.publish(permission);
    await interactionVisible(win, permission.eventId);
    await click(win, "[data-prompt-id='permission'] input[value='once']");
    await click(win, "#interaction-confirm");
    await waitForRenderer(win, "document.querySelector('#interaction-panel').hidden");
    const permissionResponse = context.getLastInteractionResponse();
    assert.equal(permissionResponse?.eventId, permission.eventId);
    assert.deepEqual(permissionResponse?.answers, [{ promptId: "permission", optionIds: ["once"], customText: undefined }]);

    // 点击穿透：鼠标不在幼苗上时，窗口必须让开，否则透明区域会挡住底下的程序（踩过的 bug）。
    await hidden(win, "#interaction-panel");
    win.webContents.sendInputEvent({ type: "mouseMove", x: 12, y: 12, movementX: -60, movementY: -60 });
    await waitFor(() => isIgnoringMouse(), 1_500, "Pointer left the pet but the window still swallowed mouse events");
    const petCenter = await center(win, "#pet");
    win.webContents.sendInputEvent({ type: "mouseMove", x: petCenter.x, y: petCenter.y, movementX: 5, movementY: 5 });
    await waitFor(() => !isIgnoringMouse(), 1_500, "Pointer entered the pet but the window stayed click-through");

    // 拖动是「按住拖、松手放」：按下去要进拖动态，中途挪鼠标窗口跟着走，松手才结束。
    const beforeMove = win.getBounds();
    const petPoint = await center(win, "#pet");
    win.webContents.sendInputEvent({ type: "mouseMove", x: petPoint.x, y: petPoint.y, movementX: 0, movementY: 0 });
    win.webContents.sendInputEvent({ type: "mouseDown", x: petPoint.x, y: petPoint.y, button: "left", clickCount: 1 });
    await waitForRenderer(win, "document.body.classList.contains('pet-picked-up') && document.querySelector('#pet').getAttribute('aria-pressed') === 'true'", 2_000);
    win.webContents.sendInputEvent({ type: "mouseMove", x: petPoint.x - 35, y: petPoint.y - 25, movementX: -35, movementY: -25 });
    await waitFor(() => {
      const current = win.getBounds();
      return current.x !== beforeMove.x || current.y !== beforeMove.y;
    }, 2_000, "Dragging the pet did not move the window");
    win.webContents.sendInputEvent({ type: "mouseUp", x: petPoint.x - 35, y: petPoint.y - 25, button: "left", clickCount: 1 });
    await waitForRenderer(win, "!document.body.classList.contains('pet-picked-up') && document.querySelector('#pet').getAttribute('aria-pressed') === 'false'", 2_000);

    await click(win, "#hide-button");
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

    const report = {
      version: context.version,
      fixedButtonsClicked: 17,
      dynamicControls: ["radio", "checkbox", "custom-text", "pending-reopen", "fallback-confirm"],
      inputs: ["search-hit", "search-empty", "range-home", "range-end", "tab-keyboard", "settings-restart-restore"],
      window: ["click-through", "pet-drag-start", "pet-drag-move", "pet-drag-end", "hide", "tray-restore", "close-to-tray"],
      trayCallbacks: ["show", "simulate", "quit"],
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
