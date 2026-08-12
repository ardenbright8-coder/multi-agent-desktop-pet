// 单实例自测：第二次启动不该再开一个后台，而是把第一个实例的窗口顶出来。

import { join } from "node:path";
import { app } from "electron";
import { LocalIpcClient } from "../channel/ipc-client";
import type { AgentHub } from "../events/hub";
import { writeJsonAtomic } from "../shared/atomic-file";
import { appDataRoot } from "../shared/paths";
import { destroyPetWindow, getPetWindow, setShuttingDown } from "../pet/window";
import type { TestHost } from "./host";
import { waitForCondition } from "./util";

export async function runSingleInstanceHostTest(_hub: AgentHub, host: TestHost): Promise<void> {
  const mainWindow = getPetWindow();
  if (!mainWindow || mainWindow.isDestroyed() || !host.getTray()) throw new Error("Single-instance host did not create the window and tray");
  const received = await waitForCondition(() => host.getSecondInstanceCount() > 0, 8_000);
  if (!received) throw new Error("First instance did not receive the second-instance signal");
  const client = new LocalIpcClient();
  const hello = await client.request("hello") as { healthy?: boolean };
  if (!hello.healthy || !mainWindow.isVisible()) throw new Error("First instance was not healthy and visible after the second launch");
  writeJsonAtomic(join(appDataRoot(), "single-instance-ok.json"), {
    version: app.getVersion(),
    secondInstanceSignals: host.getSecondInstanceCount(),
    firstInstance: "healthy",
  });
  process.stdout.write(`SINGLE_INSTANCE_OK signals=${host.getSecondInstanceCount()} first=healthy\n`);
  setShuttingDown(true);
  destroyPetWindow();
  host.destroyTray();
  await host.closeServer();
  host.markCleanupComplete();
  app.quit();
}
