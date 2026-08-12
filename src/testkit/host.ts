// 自测要动的那几样东西（托盘、事件中心服务、退出标记）都归主入口 app.ts 持有。
// testkit 不自己存这些状态，只通过这份 host 借来用——免得两边各存一份，退出时对不上。

import type { Tray } from "electron";

export interface TestHost {
  getTray(): Tray | null;
  destroyTray(): void;
  closeServer(): Promise<void>;
  markCleanupComplete(): void;
  getSecondInstanceCount(): number;
}
