// 生命周期自测：显示 → 关窗口收进托盘 → 恢复 → 后台事件中心还活着 → 待处理面板没被顺带清掉。

import { join } from "node:path";
import { app } from "electron";
import { LocalIpcClient } from "../channel/ipc-client";
import type { AgentHub } from "../events/hub";
import { makeSimulationEvent } from "../events/simulation";
import { writeJsonAtomic } from "../shared/atomic-file";
import { appDataRoot } from "../shared/paths";
import { destroyPetWindow, getPetWindow, setShuttingDown, showMainWindow } from "../pet/window";
import type { TestHost } from "./host";
import { delay, waitForCondition } from "./util";

export async function runLifecycleTest(hub: AgentHub, host: TestHost): Promise<void> {
  const mainWindow = getPetWindow();
  if (!mainWindow || mainWindow.isDestroyed() || !host.getTray()) throw new Error("Lifecycle test did not create the window and tray");
  if (mainWindow.webContents.isLoading()) {
    await new Promise<void>((resolve) => mainWindow.webContents.once("did-finish-load", () => resolve()));
  }
  await delay(150);
  mainWindow.showInactive();
  if (!mainWindow.isVisible()) throw new Error("Lifecycle test could not show the pet window");
  mainWindow.close();
  await waitForCondition(() => Boolean(!mainWindow.isDestroyed() && !mainWindow.isVisible()), 1_500);
  if (mainWindow.isDestroyed() || mainWindow.isVisible()) throw new Error("Closing the pet did not keep it alive in the tray");
  showMainWindow();
  if (!mainWindow.isVisible()) throw new Error("Tray-style restore did not show the pet window");

  const client = new LocalIpcClient();
  const hello = await client.request("hello") as { healthy?: boolean };
  if (!hello.healthy) throw new Error("Lifecycle test could not reach the background event hub");
  const permission = makeSimulationEvent("permission.requested");
  hub.publish(permission);
  hub.publish({ ...makeSimulationEvent("state.working"), sourceInstance: "lifecycle-telemetry", sessionId: permission.sessionId });
  const session = hub.snapshot().sessions.find((item) => item.sessionId === permission.sessionId);
  if (session?.state !== "waiting" || session.pendingInteraction?.eventId !== permission.eventId) {
    throw new Error("Lifecycle test lost the pending interaction after working telemetry");
  }

  writeJsonAtomic(join(appDataRoot(), "lifecycle-ok.json"), {
    version: app.getVersion(),
    window: "show-hide-restore",
    tray: "alive",
    hub: "healthy",
    pendingInteraction: "preserved",
  });
  process.stdout.write("LIFECYCLE_OK window=show-hide-restore tray=alive hub=healthy pending=preserved\n");
  setShuttingDown(true);
  destroyPetWindow();
  host.destroyTray();
  await host.closeServer();
  host.markCleanupComplete();
  app.quit();
}
