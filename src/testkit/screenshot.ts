// 截图自测：权限面板、询问面板、事件抽屉、设置面板各截一张，再把 10 种幼苗动作逐个截下来。
// 每张截图前都有 DOM 断言，截出来是空白也不会算通过。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { AgentHub } from "../events/hub";
import { makeSimulationEvent } from "../events/simulation";
import { writeJsonAtomic } from "../shared/atomic-file";
import { appDataRoot } from "../shared/paths";
import { createPetWindow, destroyPetWindow, getPetWindow, setShuttingDown } from "../pet/window";
import type { TestHost } from "./host";
import { assertRenderer, delay } from "./util";

export async function runScreenshotTest(hub: AgentHub, host: TestHost): Promise<void> {
  const mainWindow = createPetWindow(hub);
  await new Promise<void>((resolve) => mainWindow.webContents.once("did-finish-load", () => resolve()));
  hub.publish(makeSimulationEvent("permission.requested"));
  mainWindow.webContents.send("hub:snapshot", hub.snapshot());
  await delay(500);
  await assertRenderer("!document.querySelector('#interaction-panel').hidden && document.querySelector('#interaction-type').textContent.includes('权限') && document.querySelector('#interaction-heading').textContent.includes('允许')", "Permission panel did not render");
  const screenshotDir = join(process.cwd(), ".runtime");
  mkdirSync(screenshotDir, { recursive: true });
  const permissionImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(screenshotDir, "preview-permission.png"), permissionImage.toPNG());
  hub.publish(makeSimulationEvent("question.asked"));
  mainWindow.webContents.send("hub:snapshot", hub.snapshot());
  await delay(350);
  await assertRenderer("!document.querySelector('#interaction-panel').hidden && document.querySelector('#interaction-type').textContent.includes('询问') && document.querySelector('#interaction-heading').textContent.includes('滚动')", "Question panel did not render");
  const questionImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(screenshotDir, "preview-question.png"), questionImage.toPNG());
  await mainWindow.webContents.executeJavaScript("openDrawer()");
  await delay(350);
  await assertRenderer("!document.querySelector('#drawer').hidden", "Event drawer did not open");
  const drawerImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(screenshotDir, "preview-drawer.png"), drawerImage.toPNG());
  await mainWindow.webContents.executeJavaScript("document.querySelector('#drawer-close').click(); openSettings()");
  await delay(350);
  await assertRenderer("!document.querySelector('#settings-panel').hidden", "Settings panel did not open");
  const settingsImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(screenshotDir, "preview-settings.png"), settingsImage.toPNG());
  await mainWindow.webContents.executeJavaScript("document.querySelector('#settings-close').click(); document.querySelector('#interaction-top-close').click()");
  await delay(250);
  // 拖动态：按住画框（窗口主体）拖动（2026-08-14：桌面幼苗移除，改拖窗口）
  const petBox = await mainWindow.webContents.executeJavaScript("(() => { const r = document.querySelector('.scene-frame').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()") as { x: number; y: number };
  mainWindow.webContents.sendInputEvent({ type: "mouseMove", x: petBox.x, y: petBox.y, movementX: 0, movementY: 0 });
  mainWindow.webContents.sendInputEvent({ type: "mouseDown", x: petBox.x, y: petBox.y, button: "left", clickCount: 1 });
  await delay(250);
  await assertRenderer("document.body.classList.contains('pet-picked-up')", "Pressing the frame did not start a drag");
  const moveImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(screenshotDir, "preview-move.png"), moveImage.toPNG());
  mainWindow.webContents.sendInputEvent({ type: "mouseUp", x: petBox.x, y: petBox.y, button: "left", clickCount: 1 });
  await delay(150);
  await assertRenderer("!document.body.classList.contains('pet-picked-up')", "Releasing the mouse did not end the drag");
  // 场景画框截图（教室 + 座位小人；桌面幼苗已移除，不再拍姿态）
  const frameRect = await mainWindow.webContents.executeJavaScript(
    "(() => { const r = document.querySelector('.scene-frame').getBoundingClientRect(); return { x: Math.max(0, Math.round(r.x) - 8), y: Math.max(0, Math.round(r.y) - 8), width: Math.round(r.width) + 16, height: Math.round(r.height) + 16 }; })()",
  ) as { x: number; y: number; width: number; height: number };
  const sceneImage = await mainWindow.webContents.capturePage(frameRect);
  writeFileSync(join(screenshotDir, "scene-frame.png"), sceneImage.toPNG());
  writeJsonAtomic(join(appDataRoot(), "screenshot-ok.json"), { version: app.getVersion(), panels: 4, scene: 1 });
  process.stdout.write(`SCREENSHOT_OK ${screenshotDir}\n`);
  setShuttingDown(true);
  if (getPetWindow()) destroyPetWindow();
  await host.closeServer();
  app.quit();
}
