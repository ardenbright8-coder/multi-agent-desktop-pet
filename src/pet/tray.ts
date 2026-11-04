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
      // 隐藏是个开关（2026-10-27 用户）：勾上一直藏着、开机也不出来，取消勾才出来；勾没勾记在 preferences.json
      { label: "隐藏桌宠", type: "checkbox", checked: isPetHidden(), click: (item) => { setPetHidden(item.checked); rebuild(); } },
      { label: "把幼苗叫回来（回默认位置）", click: () => { actions.recall(); rebuild(); } },
      { type: "separator" },
      { label: "详情（事件与搜索）", click: actions.openDrawer },
      { label: "设置（大小与活泼程度）", click: actions.openSettings },
      { label: "书签台（随手记）", click: () => actions.openBookmark?.() },
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
  // 单击托盘图标：没勾「隐藏桌宠」才把幼苗叫到前面，勾着就不出来
  appTray.on("click", () => { if (!isPetHidden()) showMainWindow(); });
  return appTray;
}
