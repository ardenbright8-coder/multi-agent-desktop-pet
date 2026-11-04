// 托盘图标和它的右键菜单。菜单文字随事件中心状态实时重建。

import { join } from "node:path";
import { Menu, Tray, app, nativeImage, shell } from "electron";
import type { AgentHub } from "../events/hub";
import { makeSimulationEvent } from "../events/simulation";
import { flipNoteSide, hideMainWindow, isPetHidden, recallPetWindow, sendPetCommand, setPetHidden, setShuttingDown, showMainWindow } from "./window";
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
  /** 打开书签台面板。app.ts 注入 —— 书签块不反向被 pet 依赖（隔离规矩）。 */
  openBookmark?(): void;
  /** 打开「板块与内存」窗口。app.ts 注入，pet 不认识 overview 块。 */
  openOverview?(): void;
  /** 独立Gemini提示球显隐，由app.ts注入，不认识gemini内部。 */
  openGeminiQuota?(): void;
}

export function createTrayActions(
  hub: AgentHub,
  extra?: Partial<Pick<PetTrayActions, "openBookmark" | "openOverview" | "openGeminiQuota">>,
): PetTrayActions {
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
    ...extra,
  };
}

export function createTray(hub: AgentHub, actions: PetTrayActions): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, "..", "assets", "app-icon.png")).resize({ width: 16, height: 16 });
  const appTray = new Tray(icon);
  appTray.setToolTip("多Agent桌面宠物");
  const rebuild = () => {
    const diagnostics = hub.diagnostics();
    appTray.setContextMenu(Menu.buildFromTemplate([
      // 「隐藏桌宠」「找回桌宠」是一对长期开关（2026-11-04 用户定）：菜单只露当前能做的那一项，
      // 藏了就一直藏、开机也不出来，点「找回」才出来；状态记在 preferences.json 的 hidden。
      // 找回＝出来并回默认位置；露着时另给一项「回默认位置」，没藏却找不着时点它。
      ...(isPetHidden()
        ? [{ label: "找回桌宠", click: () => { setPetHidden(false); actions.recall(); rebuild(); } }]
        : [
            { label: "隐藏桌宠", click: () => { setPetHidden(true); rebuild(); } },
            { label: "桌宠回默认位置", click: () => { actions.recall(); rebuild(); } },
          ]),
      { type: "separator" },
      { label: "详情（事件与搜索）", click: actions.openDrawer },
      { label: "设置（大小与活泼程度）", click: actions.openSettings },
      { label: "Agent 看板", click: () => actions.openBookmark?.() },
      { label: "板块与内存", click: () => actions.openOverview?.() },
      ...(actions.openGeminiQuota ? [{ label: "Gemini用量提示球（显示/收起）", click: actions.openGeminiQuota }] : []),
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
  // 单击托盘图标：没隐藏才把桌宠叫到前面，隐藏着就不出来（要出来点「找回桌宠」）
  appTray.on("click", () => { if (!isPetHidden()) showMainWindow(); });
  return appTray;
}
