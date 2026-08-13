// 一次性验证：气泡条（v0.1.22）DOM 断言 + 截图。跑完可删。
// 用法：npx electron scripts/verify-bubbles.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);

const root = resolve(".runtime", "verify-bubbles");
mkdirSync(root, { recursive: true });
process.env.AGENT_PET_HUB_HOME = root;
process.env.AGENT_PET_SKIP_INTEGRATION_INSTALL = "1";

const { app, ipcMain } = require("electron");
const { AgentHub } = require("../dist/events/hub.js");
const { createPetWindow, destroyPetWindow } = require("../dist/pet/window.js");
const { eventJournalPath, discoveryPath } = require("../dist/shared/paths.js");

let seq = 0;
function ev(kind, agent, sessionId, emittedAt, extra = {}) {
  seq += 1;
  return {
    version: 1,
    eventId: `verify-${seq}`,
    sourceInstance: "verify",
    sequence: seq,
    emittedAt,
    agent,
    sessionId,
    kind,
    project: extra.project || "验证项目",
    title: extra.title || "验证会话",
    summary: extra.summary || "验证用事件",
    ...extra,
  };
}

app.whenReady().then(async () => {
  const hub = new AgentHub(eventJournalPath(), {
    running: true,
    endpoint: "verify",
    discoveryPath: discoveryPath(),
    ownerPid: process.pid,
    protocolVersion: 1,
  });
  const now = Date.now();
  // 四种状态：pi 工作中(绿) / opencode 空闲休息(黄) / claude 工作但 6 分钟没动静(红=卡顿) / hermes 报错(红=故障)
  hub.publish(ev("state.working", "pi", "pi-1", now, { project: "宠物项目" }));
  hub.publish(ev("context.updated", "opencode", "oc-1", now));
  hub.publish(ev("state.working", "claude-code", "cc-1", now - 6 * 60 * 1000));
  hub.publish(ev("task.failed", "hermes", "hm-1", now));

  const win = createPetWindow(hub);
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  await new Promise((r) => setTimeout(r, 900));

  // 点气泡 → focusAgent 链路：监听 window:focus-agent，再真实点一下第一个气泡
  let capturedHint = null;
  ipcMain.on("window:focus-agent", (_event, hint) => { capturedHint = hint; });

  const dom = await win.webContents.executeJavaScript(`(() => {
    const pills = [...document.querySelectorAll(".agent-bubble")];
    return {
      count: pills.length,
      names: pills.map((p) => (p.querySelector(".agent-name") || {}).textContent || ""),
      dots: pills.map((p) => (p.querySelector(".agent-dot") || {}).className || ""),
      stripHidden: document.querySelector("#agent-bubbles").hidden,
      stripTop: document.querySelector("#agent-bubbles").style.top,
      stripChildren: document.querySelector("#agent-bubbles").children.length,
      noteBottom: Math.round(document.querySelector("#status-note").getBoundingClientRect().bottom),
      bubbleFirstTop: pills.length ? Math.round(pills[0].getBoundingClientRect().top) : -1,
      windowH: window.innerHeight,
    };
  })()`);
  console.log("BUBBLES_DOM=" + JSON.stringify(dom, null, 1));

  const expectedDots = ["agent-dot stuck", "agent-dot working", "agent-dot stuck", "agent-dot resting"];
  const expectedNames = ["Hermes", "Pi", "Claude Code", "OpenCode"];
  const okCount = dom.count === 4 && dom.stripChildren === 4;
  const okDots = JSON.stringify(dom.dots) === JSON.stringify(expectedDots);
  const okNames = JSON.stringify(dom.names) === JSON.stringify(expectedNames);
  const okBelow = dom.bubbleFirstTop >= dom.noteBottom - 1;
  console.log(`CHECK count=${okCount} dots=${okDots} names=${okNames} belowNote=${okBelow}`);

  const shot = await win.webContents.capturePage();
  writeFileSync(join(root, "bubbles.png"), shot.toPNG());
  console.log("SHOT_SAVED=" + join(root, "bubbles.png"));

  // 点第一个气泡（Hermes）——监听器应收到 {agent, project, originPid}
  await win.webContents.executeJavaScript("document.querySelector('.agent-bubble').click();");
  await new Promise((r) => setTimeout(r, 200));
  const clickOk = capturedHint && capturedHint.agent === "hermes" && capturedHint.project === "验证项目";
  console.log("CLICK_HINT=" + JSON.stringify(capturedHint) + " ok=" + clickOk);

  // 面板弹出时气泡条要让位（:has 规则）：发个权限事件把面板弹出来，气泡条应隐藏
  hub.publish(ev("permission.requested", "pi", "pi-2", Date.now(), { requestId: "req-x", interaction: { mode: "permission", title: "允许吗", providerRequestId: "req-x", prompts: [{ id: "p", question: "允许吗？", options: [{ id: "a", label: "允许" }], multiple: false, allowCustomInput: false }], responseCapability: true, responseStatus: "pending" } }));
  win.webContents.send("hub:snapshot", hub.snapshot());
  await new Promise((r) => setTimeout(r, 400));
  const panelOpenState = await win.webContents.executeJavaScript("({ panelHidden: document.querySelector('#interaction-panel').hidden, bubblesDisplay: getComputedStyle(document.querySelector('#agent-bubbles')).display })");
  const hideOk = !panelOpenState.panelHidden && panelOpenState.bubblesDisplay === "none";
  console.log("PANEL_HIDE_BUBBLES=" + JSON.stringify(panelOpenState) + " ok=" + hideOk);

  destroyPetWindow();
  app.exit(okCount && okDots && okNames && okBelow && clickOk && hideOk ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
