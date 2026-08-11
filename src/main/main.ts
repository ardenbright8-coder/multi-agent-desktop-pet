import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import type { AgentEvent, EventKind, InteractionResponseInput, SearchQuery } from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import { writeJsonAtomic } from "./atomic-file";
import { AgentHub } from "./hub";
import { LocalIpcClient } from "./ipc-client";
import { LocalIpcServer } from "./ipc-server";
import { ensureGenericHookBridge, ensureOpenCodeIntegration } from "./integration-manager";
import { discoveryPath, eventJournalPath, preferencesPath } from "./paths";
import { clampWindowPosition, defaultWindowPosition } from "./window-position";

const smokeMode = process.argv.includes("--smoke-test");
const screenshotMode = process.argv.includes("--screenshot-test");
if (screenshotMode) app.disableHardwareAcceleration();
if (smokeMode || screenshotMode) {
  const testRoot = join(tmpdir(), `agent-pet-hub-smoke-${process.pid}`);
  process.env.AGENT_PET_HUB_HOME = testRoot;
  app.setPath("userData", join(testRoot, "electron"));
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let ipcServer: LocalIpcServer | null = null;
let shuttingDown = false;
let quitCleanupStarted = false;
let cleanupComplete = false;
let simulatorSequence = 0;
let positionBeforePanel: { x: number; y: number } | null = null;
let petPickedUp = false;
const WINDOW_SIZE = { width: 440, height: 680 };
const PET_VISIBLE_BOUNDS = { x: 218, y: 392, width: 213, height: 247 };
const PET_WINDOW_SHAPE = { x: 205, y: 360, width: 235, height: 320 };

const gotLock = smokeMode || screenshotMode || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(bootstrap).catch((error) => {
    logError(error);
    process.exitCode = 1;
    app.quit();
  });
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("local.jiakai.multiagentpet");
  app.setName("多Agent桌面宠物");

  const hub = new AgentHub(eventJournalPath(), {
    running: false,
    endpoint: "",
    discoveryPath: discoveryPath(),
    ownerPid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
  });
  ipcServer = new LocalIpcServer(hub);
  const discovery = await ipcServer.start();
  hub.updateServerInfo({ running: true, endpoint: discovery.endpoint });
  hub.on("server-error", (error) => {
    hub.updateServerInfo({ running: false });
    logError(error);
  });
  if (!smokeMode && !screenshotMode) {
    try {
      ensureOpenCodeIntegration();
      ensureGenericHookBridge();
    } catch (error) {
      logError(error);
    }
  }

  setupIpcHandlers(hub);
  const cleanupTimer = setInterval(() => hub.cleanup(), 10_000);
  cleanupTimer.unref();

  if (smokeMode) {
    await runSmokeTest(hub);
    clearInterval(cleanupTimer);
    await ipcServer.close();
    ipcServer = null;
    scheduleTestRootCleanup();
    app.quit();
    return;
  }

  if (screenshotMode) {
    mainWindow = createWindow(hub);
    await new Promise<void>((resolve) => mainWindow?.webContents.once("did-finish-load", () => resolve()));
    hub.publish(makeSimulationEvent("permission.requested"));
    await delay(500);
    const screenshotDir = join(process.cwd(), ".runtime");
    mkdirSync(screenshotDir, { recursive: true });
    const permissionImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-permission.png"), permissionImage.toPNG());
    hub.publish(makeSimulationEvent("question.asked"));
    mainWindow.webContents.send("hub:snapshot", hub.snapshot());
    await delay(350);
    const questionImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-question.png"), questionImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#open-button').click()");
    await delay(350);
    const drawerImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-drawer.png"), drawerImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#drawer-close').click(); document.querySelector('#settings-button').click()");
    await delay(350);
    const settingsImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-settings.png"), settingsImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#settings-close').click(); document.querySelector('#interaction-top-close').click(); document.querySelector('#pet').click()");
    await delay(250);
    const moveImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-move.png"), moveImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#pet').click()");
    const poses = ["idle", "thinking", "waving", "jumping", "failed", "waiting", "running", "working-focus", "working-rope", "review"];
    for (const pose of poses) {
      await mainWindow.webContents.executeJavaScript(`document.body.dataset.petPose = ${JSON.stringify(pose)}`);
      await delay(pose === "jumping" ? 390 : 210);
      const poseImage = await mainWindow.webContents.capturePage({ x: 236, y: 448, width: 198, height: 218 });
      writeFileSync(join(screenshotDir, `pose-${pose}.png`), poseImage.toPNG());
    }
    process.stdout.write(`SCREENSHOT_OK ${screenshotDir}\n`);
    shuttingDown = true;
    mainWindow.destroy();
    mainWindow = null;
    await ipcServer.close();
    ipcServer = null;
    scheduleTestRootCleanup();
    app.quit();
    return;
  }

  mainWindow = createWindow(hub);
  screen.on("display-added", keepWindowOnVisibleDisplay);
  screen.on("display-removed", keepWindowOnVisibleDisplay);
  screen.on("display-metrics-changed", keepWindowOnVisibleDisplay);
  tray = createTray(hub);
  hub.on("snapshot", (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("hub:snapshot", snapshot);
  });

  app.on("activate", showMainWindow);
  app.on("window-all-closed", () => {
    // Tray app: keep the event hub alive when the pet window is hidden.
  });
  app.on("before-quit", (event) => {
    if (cleanupComplete) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    shuttingDown = true;
    persistWindowPosition();
    Promise.resolve(ipcServer?.close())
      .catch(logError)
      .finally(() => {
        cleanupComplete = true;
        ipcServer = null;
        app.quit();
      });
  });
}

function createWindow(hub: AgentHub): BrowserWindow {
  const saved = loadWindowBounds();
  const workArea = screen.getPrimaryDisplay().workArea;
  const fallback = defaultWindowPosition(workArea, WINDOW_SIZE);
  const bounds = saved
    ? clampWindowPosition(saved, screen.getAllDisplays().map((display) => display.workArea), WINDOW_SIZE, PET_VISIBLE_BOUNDS)
    : fallback;
  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setShape([PET_WINDOW_SHAPE]);
  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    win.showInactive();
    win.webContents.send("hub:snapshot", hub.snapshot());
  });
  let saveTimer: NodeJS.Timeout | null = null;
  win.on("move", () => {
    if (positionBeforePanel) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed()) persistWindowPosition();
    }, 300);
  });
  win.on("close", (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}

function setupIpcHandlers(hub: AgentHub): void {
  ipcMain.handle("hub:snapshot", () => hub.snapshot());
  ipcMain.handle("hub:search", (_event, query: SearchQuery) => hub.search(query || {}));
  ipcMain.handle("hub:diagnostics", () => hub.diagnostics());
  ipcMain.handle("hub:interaction-respond", (_event, response: InteractionResponseInput) => {
    const result = hub.submitInteractionResponse(response);
    if (response?.agent === "simulator") {
      const claim = hub.claimInteractionResponse({
        eventId: response.eventId,
        agent: response.agent,
        sessionId: response.sessionId,
        providerRequestId: response.providerRequestId,
        sourceInstance: "desktop-simulator",
      });
      if (claim) hub.completeInteractionResponse({ responseId: claim.responseId, claimToken: claim.claimToken, success: true });
    }
    return result;
  });
  ipcMain.handle("hub:simulate", (_event, requestedKind?: string) => {
    const event = makeSimulationEvent(requestedKind as EventKind | undefined);
    hub.publish(event);
    return hub.snapshot();
  });
  ipcMain.on("window:move-to-pointer", (_event, position: { screenX?: unknown; screenY?: unknown; anchorX?: unknown; anchorY?: unknown }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const values = [position?.screenX, position?.screenY, position?.anchorX, position?.anchorY];
    if (!values.every(Number.isFinite)) return;
    const x = Math.round(Number(position.screenX) - Number(position.anchorX));
    const y = Math.round(Number(position.screenY) - Number(position.anchorY));
    mainWindow.setPosition(x, y, false);
  });
  ipcMain.on("window:finish-move", () => keepWindowOnVisibleDisplay());
  ipcMain.on("window:pickup-state", (_event, pickedUp: boolean) => {
    petPickedUp = Boolean(pickedUp);
    updateWindowShape();
  });
  ipcMain.on("window:panel-visibility", (_event, visible: boolean) => setPanelVisibility(Boolean(visible)));
  ipcMain.on("window:hide", () => mainWindow?.hide());
}

function createTray(hub: AgentHub): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, "..", "assets", "app-icon.png")).resize({ width: 16, height: 16 });
  const appTray = new Tray(icon);
  appTray.setToolTip("多Agent桌面宠物");
  const rebuild = () => {
    const diagnostics = hub.diagnostics();
    appTray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示桌宠", click: showMainWindow },
      { label: `事件中心：${diagnostics.server.running ? "正常" : "异常"}`, enabled: false },
      { label: `已索引：${diagnostics.journal.count} 条`, enabled: false },
      { type: "separator" },
      { label: "发一条测试通知", click: () => hub.publish(makeSimulationEvent("permission.requested")) },
      { type: "separator" },
      { label: "退出", click: () => { shuttingDown = true; app.quit(); } },
    ]));
  };
  rebuild();
  hub.on("snapshot", rebuild);
  appTray.on("click", showMainWindow);
  return appTray;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.showInactive();
}

function loadWindowBounds(): { x: number; y: number } | null {
  try {
    if (!existsSync(preferencesPath())) return null;
    const value = JSON.parse(readFileSync(preferencesPath(), "utf8")) as { x?: unknown; y?: unknown };
    return Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x as number, y: value.y as number } : null;
  } catch {
    return null;
  }
}

function persistWindowPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = mainWindow.getBounds();
  writeJsonAtomic(preferencesPath(), { x, y });
}

function keepWindowOnVisibleDisplay(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (positionBeforePanel) {
    positionBeforePanel = clampWindowPosition(positionBeforePanel, workAreas, WINDOW_SIZE, PET_VISIBLE_BOUNDS);
    const currentPanelPosition = mainWindow.getBounds();
    const visiblePanelPosition = clampWindowPosition(currentPanelPosition, workAreas, WINDOW_SIZE);
    if (visiblePanelPosition.x !== currentPanelPosition.x || visiblePanelPosition.y !== currentPanelPosition.y) {
      mainWindow.setPosition(visiblePanelPosition.x, visiblePanelPosition.y);
    }
    return;
  }
  const current = mainWindow.getBounds();
  const next = clampWindowPosition(current, workAreas, WINDOW_SIZE, PET_VISIBLE_BOUNDS);
  if (next.x !== current.x || next.y !== current.y) mainWindow.setPosition(next.x, next.y);
  persistWindowPosition();
}

function setPanelVisibility(visible: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (visible) {
    if (positionBeforePanel) return;
    positionBeforePanel = mainWindow.getBounds();
    const next = clampWindowPosition(positionBeforePanel, workAreas, WINDOW_SIZE);
    mainWindow.setPosition(next.x, next.y, false);
    updateWindowShape();
    return;
  }
  if (!positionBeforePanel) return;
  const restore = clampWindowPosition(positionBeforePanel, workAreas, WINDOW_SIZE, PET_VISIBLE_BOUNDS);
  positionBeforePanel = null;
  mainWindow.setPosition(restore.x, restore.y, false);
  persistWindowPosition();
  updateWindowShape();
}

function updateWindowShape(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setShape(positionBeforePanel || petPickedUp ? [{ x: 0, y: 0, ...WINDOW_SIZE }] : [PET_WINDOW_SHAPE]);
}

function makeSimulationEvent(kind?: EventKind): AgentEvent {
  const kinds: EventKind[] = ["state.thinking", "state.working", "question.asked", "permission.requested", "task.completed", "task.failed"];
  const selected = kind && kinds.includes(kind) ? kind : kinds[simulatorSequence % kinds.length];
  simulatorSequence += 1;
  const isPermission = selected === "permission.requested";
  const isQuestion = selected === "question.asked";
  const requestId = isPermission || isQuestion ? randomUUID() : undefined;
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: "desktop-simulator",
    sequence: simulatorSequence,
    emittedAt: Date.now(),
    agent: "simulator",
    sessionId: "demo-session",
    kind: selected,
    project: "多 Agent 桌面宠物",
    title: "验证统一通知链路",
    summary: isPermission ? "准备修改事件索引并运行验证" : isQuestion ? "正在确定长内容在面板里的呈现方式" : stateSummary(selected),
    reason: isPermission ? "现有索引缺少交互状态，需要写入模块才能完成这次实现" : isQuestion ? "长说明必须保持可读，同时底部操作不能被滚出窗口" : "这是一条本地模拟事件",
    tool: isPermission ? "apply_patch" : selected === "state.working" ? "test" : isQuestion ? "question" : undefined,
    target: isPermission ? "src/main/event-index.ts" : isQuestion ? "面板内容较长时采用哪种布局" : undefined,
    paths: isPermission ? ["src/main/event-index.ts"] : undefined,
    requestId,
    interaction: isPermission ? {
      mode: "permission",
      title: "允许修改事件索引并运行测试吗？",
      providerRequestId: requestId,
      prompts: [{
        id: "permission",
        question: "请选择这次权限范围",
        multiple: false,
        allowCustomInput: false,
        options: [
          { id: "once", label: "允许一次", value: "once", description: "只执行当前这次修改和验证", recommended: true },
          { id: "reject", label: "拒绝", value: "reject", description: "不执行，Agent 返回原窗口等待" },
        ],
      }],
      recommendation: "允许一次，范围只覆盖列出的文件和测试",
      action: "修改文件并运行项目测试",
      resources: ["src/main/event-index.ts", "项目测试命令"],
      impact: "会改动一个源码文件并启动本地测试进程，不删除文件。",
      rollback: "源码有 Git 时可以回退；测试进程结束后不常驻。",
      unknowns: "测试耗时还没核实",
      responseCapability: true,
      responseStatus: "pending",
    } : isQuestion ? {
      mode: "question",
      title: "长内容应该怎么滚动？",
      providerRequestId: requestId,
      prompts: [{
        id: "layout",
        question: "面板内容超过一屏时，操作区应该放在哪里？",
        multiple: false,
        allowCustomInput: true,
        options: [
          { id: "sticky", label: "固定底部操作", value: "固定底部操作", description: "正文单独滚动，关闭和确认始终可用", recommended: true },
          { id: "all-scroll", label: "整页一起滚动", value: "整页一起滚动", description: "结构简单，但长内容时要滚到底才能操作" },
        ],
      }],
      recommendation: "固定底部操作，长说明只在正文区域滚动",
      impact: "只影响面板布局和操作可达性，不改 Agent 原始选项。",
      responseCapability: true,
      responseStatus: "pending",
    } : undefined,
  };
}

function stateSummary(kind: EventKind): string {
  const labels: Partial<Record<EventKind, string>> = {
    "state.thinking": "正在理解任务和安排步骤",
    "state.working": "正在执行工具和验证结果",
    "task.completed": "任务已经完成，可以回来查看",
    "task.failed": "任务遇到错误，需要回来处理",
  };
  return labels[kind] || "状态发生变化";
}

async function runSmokeTest(hub: AgentHub): Promise<void> {
  const client = new LocalIpcClient();
  await client.request("hello");
  await client.publish(makeSimulationEvent("state.working"));
  await client.publish(makeSimulationEvent("permission.requested"));
  const hits = await client.search({ text: "实时索引", limit: 10 });
  const snapshot = hub.snapshot();
  if (hits.length < 1 || snapshot.eventCount < 2 || snapshot.sessions.length < 1) {
    throw new Error(`Smoke test failed: hits=${hits.length}, events=${snapshot.eventCount}, sessions=${snapshot.sessions.length}`);
  }
  process.stdout.write(`SMOKE_OK events=${snapshot.eventCount} hits=${hits.length} endpoint=named-pipe\n`);
}

function logError(error: unknown): void {
  const message = error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`;
  try {
    appendFileSync(join(process.env.AGENT_PET_HUB_HOME || tmpdir(), "agent-pet-error.log"), message, "utf8");
  } catch {
    // Last-resort logger must never crash the app.
  }
  process.stderr.write(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleTestRootCleanup(): void {
  const root = process.env.AGENT_PET_HUB_HOME;
  if (!root) return;
  app.once("quit", () => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows can release cache files after process exit. */ }
  });
}
