// 主入口：只装配，不放业务逻辑。
// 建事件中心 → 起本机通道 → 装接入 → 挂 IPC → 开窗口和托盘 → 挂退出清理。
// 要改某一块的行为，进对应功能夹改，别往这儿加。

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, type Tray } from "electron";
import type { InteractionResponseInput, SessionSnapshot } from "./shared/protocol";
import { PROTOCOL_VERSION } from "./shared/protocol";
import { appDataRoot, discoveryPath, eventJournalPath } from "./shared/paths";
import { createLogger, lastLogError, logRoot, startLog } from "./shared/log";
import { AgentHub } from "./events/hub";
import { LocalIpcServer } from "./channel/ipc-server";
import { registerHubIpc } from "./channel/ipc-handlers";
import { ensureGenericHookBridge, ensureGrokHooks, ensureOpenCodeIntegration } from "./integrations/manager";
import {
  createPetWindow,
  ensureFullyVisible,
  getPetWindow,
  persistWindowPosition,
  setShuttingDown,
  showMainWindow,
  watchDisplayChanges,
} from "./pet/window";
import { registerWindowIpc } from "./pet/window-ipc";
import { createTray, createTrayActions } from "./pet/tray";
import { controlsMode, lifecycleMode, screenshotMode, singleInstanceHostMode, smokeMode, testMode, testModeName } from "./testkit/modes";
import { runControlsTest } from "./testkit/controls-test";
import { runLifecycleTest } from "./testkit/lifecycle";
import { runScreenshotTest } from "./testkit/screenshot";
import { runSingleInstanceHostTest } from "./testkit/single-instance";
import { runSmokeTest } from "./testkit/smoke";
import type { TestHost } from "./testkit/host";

const skipIntegrationInstall = process.env.AGENT_PET_SKIP_INTEGRATION_INSTALL === "1"
  || process.argv.includes("--skip-integration-install");
if (screenshotMode) app.disableHardwareAcceleration();
if (testMode && !process.env.AGENT_PET_HUB_HOME) {
  const testRoot = join(process.cwd(), ".runtime", "test-runs", `${testModeName()}-${process.pid}`);
  process.env.AGENT_PET_HUB_HOME = testRoot;
}
if (process.env.AGENT_PET_HUB_HOME) app.setPath("userData", join(process.env.AGENT_PET_HUB_HOME, "electron"));

const log = createLogger("app");

let tray: Tray | null = null;
let ipcServer: LocalIpcServer | null = null;
let quitCleanupStarted = false;
let cleanupComplete = false;
let secondInstanceCount = 0;
let lastControlsInteractionResponse: InteractionResponseInput | null = null;

const testHost: TestHost = {
  getTray: () => tray,
  destroyTray: () => { tray?.destroy(); tray = null; },
  closeServer: async () => { await ipcServer?.close(); ipcServer = null; },
  markCleanupComplete: () => { cleanupComplete = true; },
  getSecondInstanceCount: () => secondInstanceCount,
};

const gotLock = smokeMode || screenshotMode || controlsMode || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    secondInstanceCount += 1;
    showMainWindow();
  });
  app.whenReady().then(bootstrap).catch((error) => {
    logError(error);
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("local.jiakai.multiagentpet");
  app.setName("多Agent桌面宠物");
  startLog({ version: app.getVersion(), electron: process.versions.electron, pid: process.pid, testMode });

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
  log.记(`本机通道已就绪 endpoint=${discovery.endpoint}`, "bootstrap");
  hub.on("server-error", (error) => {
    hub.updateServerInfo({ running: false });
    log.出事("本机通道出错，事件中心已标记为异常", error, "server-error");
    logError(error);
  });
  if (!testMode && !skipIntegrationInstall) {
    try {
      ensureOpenCodeIntegration();
      ensureGenericHookBridge();
      ensureGrokHooks();
      log.记("五家接入已同步", "bootstrap");
    } catch (error) {
      log.出事("装接入失败", error, "bootstrap");
      logError(error);
    }
  }

  registerHubIpc(hub, {
    onInteractionResponse: (response) => {
      if (controlsMode) lastControlsInteractionResponse = response;
    },
  });
  registerWindowIpc();
  const cleanupTimer = setInterval(() => hub.cleanup(), 10_000);
  cleanupTimer.unref();

  if (smokeMode) {
    await runSmokeTest(hub);
    clearInterval(cleanupTimer);
    await testHost.closeServer();
    app.quit();
    return;
  }

  if (screenshotMode) {
    await runScreenshotTest(hub, testHost);
    return;
  }

  const mainWindow = createPetWindow(hub);
  watchDisplayChanges();
  const trayActions = createTrayActions(hub);
  tray = createTray(hub, trayActions);
  hub.on("snapshot", (snapshot) => {
    const window = getPetWindow();
    if (window && !window.isDestroyed()) window.webContents.send("hub:snapshot", snapshot);
    // 兜底：有事等你处理时，不管界面那边的通知丢没丢，先保证整个窗口在屏幕里，
    // 否则面板的确认按钮可能留在屏幕外，人点不着（2026-08-12 实机踩过）。
    if (snapshot.sessions.some((session: SessionSnapshot) => session.pendingInteraction)) ensureFullyVisible();
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
    log.记("收到退出请求，开始清理", "before-quit");
    setShuttingDown(true);
    persistWindowPosition();
    Promise.resolve(ipcServer?.close())
      .catch(logError)
      .finally(() => {
        cleanupComplete = true;
        ipcServer = null;
        app.quit();
      });
  });

  if (lifecycleMode) await runLifecycleTest(hub, testHost);
  if (singleInstanceHostMode) await runSingleInstanceHostTest(hub, testHost);
  if (controlsMode && tray) {
    await runControlsTest({
      window: mainWindow,
      tray,
      hub,
      trayActions,
      reportPath: join(appDataRoot(), "controls-ok.json"),
      failureScreenshotPath: join(appDataRoot(), "controls-failure.png"),
      version: app.getVersion(),
      getLastInteractionResponse: () => lastControlsInteractionResponse,
    });
  }
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
