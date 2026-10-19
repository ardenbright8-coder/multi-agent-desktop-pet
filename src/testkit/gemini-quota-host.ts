// 仅用于公共Playwright驱动的隔离验收；不启动其他板块，不装Agent接入。
import { app } from "electron";
import { initGeminiQuota, closeGeminiQuota } from "../gemini/gemini-quota";
app.setPath("userData", process.env.AGENT_PET_HUB_HOME!);
void app.whenReady().then(() => initGeminiQuota({ display: false }));
let closing = false;
app.on("window-all-closed", () => {});
app.on("before-quit", event => { if (closing) return; event.preventDefault(); closing = true; void closeGeminiQuota().finally(() => app.quit()); });
