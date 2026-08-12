// 托盘图标和它的右键菜单。菜单文字随事件中心状态实时重建。

import { join } from "node:path";
import { Menu, Tray, app, nativeImage, shell } from "electron";
import type { AgentHub } from "../events/hub";
import { makeSimulationEvent } from "../events/simulation";
import { flipNoteSide, hideMainWindow, recallPetWindow, sendPetCommand, setShuttingDown, showMainWindow } from "./window";
import { logRoot } from "../shared/log";

export interface PetTrayActions {
  show(): void;
  recall(): void;
  openDrawer(): void;
  openSettings(): void;
  hide(): void;
  flipNote(): void;
  openLogs(): void;
  simulate(): void;
  quit(): void;
}

export function createTrayActions(hub: AgentHub): PetTrayActions {
  return {
    show: showMainWindow,
    recall: recallPetWindow,
    openDrawer: () => sendPetCommand("drawer"),
    openSettings: () => sendPetCommand("settings"),
    hide: hideMainWindow,
    flipNote: flipNoteSide,
    openLogs: () => { void shell.openPath(logRoot()); },
    simulate: () => { hub.publish(makeSimulationEvent("permission.requested")); },
    quit: () => { setShuttingDown(true); app.quit(); },
  };
}

export function createTray(hub: AgentHub, actions: PetTrayActions): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, "..", "assets", "app-icon.png")).resize({ width: 16, height: 16 });
  const appTray = new Tray(icon);
  appTray.setToolTip("多Agent桌面宠物");
  const rebuild = () => {
    const diagnostics = hub.diagnostics();
    appTray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示桌宠", click: actions.show },
      { label: "把幼苗叫回来（回默认位置）", click: actions.recall },
      { label: "藏起来", click: actions.hide },
      { type: "separator" },
      { label: "详情（事件与搜索）", click: actions.openDrawer },
      { label: "设置（大小与活泼程度）", click: actions.openSettings },
      { label: "聊天框换个边", click: actions.flipNote },
      { label: `事件中心：${diagnostics.server.running ? "正常" : "异常"}`, enabled: false },
      { label: `已索引：${diagnostics.journal.count} 条`, enabled: false },
      { type: "separator" },
      { label: "发一条测试通知", click: actions.simulate },
      { label: "打开日志文件夹", click: actions.openLogs },
      { type: "separator" },
      { label: "退出", click: actions.quit },
    ]));
  };
  rebuild();
  hub.on("snapshot", rebuild);
  appTray.on("click", showMainWindow);
  return appTray;
}
