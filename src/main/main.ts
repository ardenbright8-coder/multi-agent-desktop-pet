import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import type { AgentEvent, EventKind, SearchQuery } from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import { writeJsonAtomic } from "./atomic-file";
import { AgentHub } from "./hub";
import { LocalIpcClient } from "./ipc-client";
import { LocalIpcServer } from "./ipc-server";
import { ensureGenericHookBridge, ensureOpenCodeIntegration } from "./integration-manager";
import { discoveryPath, eventJournalPath, preferencesPath } from "./paths";

const smokeMode = process.argv.includes("--smoke-test");
const screenshotMode = process.argv.includes("--screenshot-test");
if (screenshotMode) app.disableHardwareAcceleration();
if (smokeMode || screenshotMode) {
  process.env.AGENT_PET_HUB_HOME = join(tmpdir(), `agent-pet-hub-smoke-${process.pid}`);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let ipcServer: LocalIpcServer | null = null;
let shuttingDown = false;
let quitCleanupStarted = false;
let cleanupComplete = false;
let simulatorSequence = 0;

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
  try {
    ensureOpenCodeIntegration();
    ensureGenericHookBridge();
  } catch (error) {
    logError(error);
  }

  setupIpcHandlers(hub);
  const cleanupTimer = setInterval(() => hub.cleanup(), 10_000);
  cleanupTimer.unref();

  if (smokeMode) {
    await runSmokeTest(hub);
    clearInterval(cleanupTimer);
    await ipcServer.close();
    ipcServer = null;
    const smokeRoot = process.env.AGENT_PET_HUB_HOME;
    if (smokeRoot) rmSync(smokeRoot, { recursive: true, force: true });
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
    await mainWindow.webContents.executeJavaScript("document.querySelector('#open-button').click()");
    await delay(350);
    const drawerImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-drawer.png"), drawerImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#drawer-close').click(); document.querySelector('#settings-button').click()");
    await delay(350);
    const settingsImage = await mainWindow.webContents.capturePage();
    writeFileSync(join(screenshotDir, "preview-settings.png"), settingsImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#settings-close').click()");
    const poses = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"];
    for (const pose of poses) {
      await mainWindow.webContents.executeJavaScript(`document.body.dataset.petPose = ${JSON.stringify(pose)}`);
      await delay(pose === "jumping" ? 390 : pose.startsWith("running-") ? 210 : 180);
      const poseImage = await mainWindow.webContents.capturePage({ x: 236, y: 448, width: 198, height: 218 });
      writeFileSync(join(screenshotDir, `pose-${pose}.png`), poseImage.toPNG());
    }
    process.stdout.write(`SCREENSHOT_OK ${screenshotDir}\n`);
    shuttingDown = true;
    mainWindow.destroy();
    mainWindow = null;
    await ipcServer.close();
    ipcServer = null;
    const screenshotRoot = process.env.AGENT_PET_HUB_HOME;
    if (screenshotRoot) rmSync(screenshotRoot, { recursive: true, force: true });
    app.quit();
    return;
  }

  mainWindow = createWindow(hub);
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
  const bounds = loadWindowBounds();
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 440;
  const height = 680;
  const win = new BrowserWindow({
    width,
    height,
    x: bounds?.x ?? workArea.x + workArea.width - width - 28,
    y: bounds?.y ?? workArea.y + workArea.height - height - 22,
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
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    win.showInactive();
    win.webContents.send("hub:snapshot", hub.snapshot());
  });
  let saveTimer: NodeJS.Timeout | null = null;
  let previousX = win.getBounds().x;
  win.on("move", () => {
    const currentX = win.getBounds().x;
    const deltaX = currentX - previousX;
    if (Math.abs(deltaX) >= 2 && !win.webContents.isDestroyed()) {
      win.webContents.send("window:pet-motion", deltaX < 0 ? "left" : "right");
    }
    previousX = currentX;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        const { x, y } = win.getBounds();
        writeJsonAtomic(preferencesPath(), { x, y });
      }
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
  ipcMain.handle("hub:simulate", (_event, requestedKind?: string) => {
    const event = makeSimulationEvent(requestedKind as EventKind | undefined);
    hub.publish(event);
    return hub.snapshot();
  });
  ipcMain.on("window:mouse-passthrough", (_event, enabled: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
  });
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

function makeSimulationEvent(kind?: EventKind): AgentEvent {
  const kinds: EventKind[] = ["state.thinking", "state.working", "permission.requested", "task.completed", "task.failed"];
  const selected = kind && kinds.includes(kind) ? kind : kinds[simulatorSequence % kinds.length];
  simulatorSequence += 1;
  const isPermission = selected === "permission.requested";
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
    summary: isPermission ? "正在实现实时内容索引" : stateSummary(selected),
    reason: isPermission ? "需要写入索引模块并运行测试" : "这是一条本地模拟事件",
    tool: isPermission ? "apply_patch" : selected === "state.working" ? "test" : undefined,
    target: isPermission ? "src/main/event-index.ts" : undefined,
    paths: isPermission ? ["src/main/event-index.ts"] : undefined,
    requestId: isPermission ? randomUUID() : undefined,
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
