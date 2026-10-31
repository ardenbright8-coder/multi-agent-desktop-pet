// 主入口：只装配，不放业务逻辑。
// 建事件中心 → 起本机通道 → 装接入 → 挂 IPC → 开窗口和托盘 → 挂退出清理。
// 要改某一块的行为，进对应功能夹改，别往这儿加。

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, type Tray } from "electron";
import type { InteractionResponseInput, SessionSnapshot } from "./shared/protocol";
import { PROTOCOL_VERSION } from "./shared/protocol";
import { appDataRoot, discoveryPath, eventJournalPath, isIsolatedRun } from "./shared/paths";
import { createLogger, lastLogError, logRoot, startLog } from "./shared/log";
import { AgentHub } from "./events/hub";
import { LocalIpcServer } from "./channel/ipc-server";
import { registerHubIpc } from "./channel/ipc-handlers";
import { ensureAgentHookPaths, ensureGenericHookBridge, ensureGrokHooks, ensureOpenCodeIntegration } from "./integrations/manager";
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
import { closeBookmarkPanel, initBookmarkPanel, relaunchWithNewCode, toggleBookmarkPanel } from "./bookmark/panel-window";
import { closeQuickCmd, initQuickCmd } from "./quickcmd/quickcmd-window";
import { closeVivoClip, initVivoClip, vivoClipStatus } from "./vivo/vivo-clip";
import { closeOverview, initOverview, openOverview, type BlockInfo } from "./overview/overview-window";
import { initGeminiQuota, closeGeminiQuota, toggleGeminiQuota, geminiQuotaStatus } from "./gemini/gemini-quota";
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
// 自测一律进自己的隔离夹并打标记。用户环境变量里的 AGENT_PET_HUB_HOME 是真数据（两套共用），不能被测试拿去写。
if (testMode && !isIsolatedRun()) {
  const testRoot = join(process.cwd(), ".runtime", "test-runs", `${testModeName()}-${process.pid}`);
  process.env.AGENT_PET_HUB_HOME = testRoot;
}
if (testMode) process.env.AGENT_PET_ISOLATED = "1";
if (process.env.AGENT_PET_HUB_HOME) app.setPath("userData", join(process.env.AGENT_PET_HUB_HOME, "electron"));

const log = createLogger("app");

let tray: Tray | null = null;
let ipcServer: LocalIpcServer | null = null;
let quitCleanupStarted = false;
let cleanupComplete = false;
let secondInstanceCount = 0;
let lastControlsInteractionResponse: InteractionResponseInput | null = null;
let bookmarkState: BlockInfo["state"] = "没启用";

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
      ensureGrokHooks();
      log.记("五家接入已同步", "bootstrap");
    } catch (error) {
      log.出事("装接入失败", error, "bootstrap");
      logError(error);
    }
  }
  // 钩子桥和各家指过来的路径每次启动都对一遍，不看 --skip-integration-install：
  // 只动自己那份桥和自己那几条钩子命令。程序或数据夹换了地方，重开一次就接上（2026-10-31）。
  if (!testMode) {
    try {
      const bridge = ensureGenericHookBridge();
      if (bridge.reason) log.记(`钩子桥没更新（${bridge.reason}）：${bridge.target}`, "bootstrap");
      const paths = ensureAgentHookPaths();
      if (paths.changed.length) log.记(`钩子路径已改指 ${bridge.target}：${paths.changed.join("、")}`, "bootstrap");
    } catch (error) {
      log.出事("对钩子路径失败", error, "bootstrap");
      logError(error);
    }
  }

  registerHubIpc(hub, {
    onInteractionResponse: (response) => {
      if (controlsMode) lastControlsInteractionResponse = response;
    },
  });
  registerWindowIpc({ openOverview });
  // 书签台（独立板块，2026-09-09 并入）：坏了不许连坐桌宠本体，这里兠住。
  try {
    initBookmarkPanel({ hotkey: !testMode, resident: !testMode, inbox: !testMode, liveRestart: !testMode });
    bookmarkState = "在跑";
  } catch (error) {
    bookmarkState = "出错";
    log.出事("书签台初始化失败（不影响桌宠本体）", error, "bookmark");
  }
  // Agent命令快捷窗口（独立板块，2026-10-12 并入）：终端里按 Ctrl+Q 弹出。自测不起，别跟真机抢 Ctrl+Q。
  if (!testMode) initQuickCmd();
  // vivo 截图复制（独立板块，2026-10-18 并入）：后台盯剪贴板。自测不起，别动真机剪贴板。
  if (!testMode) initVivoClip();
  // Gemini额度（独立第五板块）：官网只读采集，提示球不聚焦、不截鼠标，异常不连坐原有板块。
  if (!testMode) await initGeminiQuota({ anchor: () => getPetWindow()?.getBounds() });
  // 板块与内存（2026-10-18）：右键「板块与内存」看装了几个板块、占多少内存。新并入板块记得往 blockList 里加一行。
  initOverview(blockList);
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
  // 桌宠小窗口里按 Ctrl+R 也换新代码，跟看板同一份（2026-10-24 用户：桌宠和看板两个窗口按哪个都整个程序换新）。
  // 只在这个窗口里认，🚨 不注册 globalShortcut，不拦其他软件的 Ctrl+R。
  if (!testMode) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || !(input.control || input.meta) || input.key.toLowerCase() !== "r") return;
      event.preventDefault();
      if (!input.isAutoRepeat) void relaunchWithNewCode();
    });
  }
  watchDisplayChanges();
  const trayActions = createTrayActions(hub, { openBookmark: toggleBookmarkPanel, openOverview, openGeminiQuota: toggleGeminiQuota });
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
    closeBookmarkPanel();
    closeQuickCmd();
    closeVivoClip();
    closeOverview();
    Promise.all([ipcServer?.close(), closeGeminiQuota()])
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

/** 「板块与内存」窗口里列的板块。一个板块一行，新并入的往这儿加。 */
function blockList(): BlockInfo[] {
  const vivo = vivoClipStatus();
  const gemini = geminiQuotaStatus();
  const running: BlockInfo["state"] = testMode ? "没启用" : "在跑";
  return [
    { name: "桌宠本体", what: "盯各家 AI 的状态，弹询问、权限、完成；点座位切回终端", state: "在跑" },
    { name: "Agent 看板", what: "派活、交接单、随手记", state: bookmarkState },
    { name: "Ctrl+Q 命令窗口", what: "终端里按 Ctrl+Q 弹一列命令按钮", state: running },
    {
      name: "vivo 截图复制",
      what: "vivo 点「复制」后另存成图片文件放进剪贴板，网页、微信、命令窗口（Ctrl+V 贴位置）都能贴；顺带看拖图补丁在不在",
      state: vivo.state,
      detail: `${vivo.converted ? `这次开机补了 ${vivo.converted} 张` : "这次开机还没补过"}｜拖图补丁：${vivo.dragPatch}`,
    },
    { name: "Gemini 用量", what: "每账号一个小提示球，只常显5小时额度和重置时间；周额度后台保留", state: gemini.state, detail: gemini.detail },
  ];
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
