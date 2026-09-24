// 图文与看板回归的隔离宿主：隐藏窗口、禁热键/联网/整机接入；剪贴板仅测试进程内存。
const { app, BrowserWindow, clipboard } = require("electron");
const { join } = require("node:path");
if (!process.env.AGENT_PET_HUB_HOME) throw new Error("测试必须提供独立数据目录");
app.setPath("userData", join(process.env.AGENT_PET_HUB_HOME, "electron"));
app.disableHardwareAcceleration();
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
BrowserWindow.prototype.focus = function () {};
let copied = "";
clipboard.writeText = (text) => { copied = text; };
clipboard.readText = () => copied;
app.whenReady().then(() => {
  require("../dist/bookmark/panel-window").initBookmarkPanel({hotkey:false, resident:true, inbox:false, liveRestart:false});
});
