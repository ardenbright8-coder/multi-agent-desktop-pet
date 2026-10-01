// 一次性验证：座位环境第二版（v0.1.23）——教室背景 + 9 工位对齐。跑完可删。
// 用法：npx electron scripts/verify-seats.mjs
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);

const root = resolve(".runtime", "verify-seats");
// 每次跑都用干净的日记目录，否则上一轮的 journal 重放会把新事件判成 stale（sequence 去重）
rmSync(root, { recursive: true, force: true });
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
  // 9 个会话全坐满；含一个 done（完成）状态验证通用表情图回落（assets/avatars/done.png）
  hub.publish(ev("state.working", "pi", "pi-1", now, { project: "宠物项目" }));
  hub.publish(ev("context.updated", "opencode", "oc-1", now));
  hub.publish(ev("state.working", "claude-code", "cc-1", now - 6 * 60 * 1000));
  hub.publish(ev("task.failed", "hermes", "hm-1", now));
  hub.publish(ev("state.working", "grok", "gk-1", now));
  hub.publish(ev("state.thinking", "codex", "cx-1", now));
  hub.publish(ev("state.working", "simulator", "sm-1", now));
  hub.publish(ev("task.completed", "pi", "pi-2", now));
  hub.publish(ev("state.working", "opencode", "oc-2", now));

  const win = createPetWindow(hub);
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  await new Promise((r) => setTimeout(r, 900));

  let capturedHint = null;
  ipcMain.on("window:focus-agent", (_event, hint) => { capturedHint = hint; });

  const dom = await win.webContents.executeJavaScript(`(() => {
    const seats = [...document.querySelectorAll(".seat-filled")];
    const pos = (s) => {
      const r = s.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const seatsBox = document.querySelector("#agent-seats").getBoundingClientRect();
    const frame = document.querySelector(".scene-frame").getBoundingClientRect();
    return {
      bgLoaded: document.querySelector("#scene-bg").complete && document.querySelector("#scene-bg").naturalWidth > 0,
      bgSize: document.querySelector("#scene-bg").naturalWidth + "x" + document.querySelector("#scene-bg").naturalHeight,
      seatCount: seats.length,
      positions: seats.map(pos),
      avatars: seats.map((s) => {
        const img = s.querySelector(".seat-avatar");
        return { src: (img || {}).src || "", hidden: (img || {}).hidden ?? null, expr: (img || {}).dataset?.expr || "" };
      }),
      noDots: document.querySelectorAll(".seat-dot").length,
      seatsBox: { x: Math.round(seatsBox.left), y: Math.round(seatsBox.top), w: Math.round(seatsBox.width), h: Math.round(seatsBox.height) },
      frame: { x: Math.round(frame.left), y: Math.round(frame.top), w: Math.round(frame.width), h: Math.round(frame.height), r: getComputedStyle(document.querySelector(".scene-frame")).borderRadius },
      windowW: window.innerWidth,
      windowH: window.innerHeight,
    };
  })()`);
  console.log("SEATS_DOM=" + JSON.stringify(dom, null, 1));

  // 期望：9 个座位对齐背景图里的 9 把椅背（2026-08-14 重标）。
  // 落位是 left ＋ bottom 定的（画布底边压桌面上沿），这里换算成中心点：
  //   中心 y = 1 - bottom - 画布高的一半，画布是正方形，高 = width × 1672/941。
  const expected = [
    [0.293, 0.2455], [0.508, 0.2455], [0.727, 0.2455],
    [0.288, 0.433], [0.505, 0.433], [0.724, 0.433],
    [0.279, 0.6405], [0.498, 0.6405], [0.722, 0.6405],
  ];
  const okCount = dom.seatCount === 9;
  const okBg = dom.bgLoaded && dom.bgSize === "1672x941";
  // 座位坐标 = 图内百分比 × agent-seats 实际尺寸（图 contain 在画框内，尺寸随窗口/缩放变化）
  const sb = dom.seatsBox;
  const okPos = dom.positions.every((p, i) => {
    const want = expected[i];
    const dx = Math.abs(p.x - (sb.x + want[0] * sb.w));
    const dy = Math.abs(p.y - (sb.y + want[1] * sb.h));
    return dx <= 16 && dy <= 16;
  });
  // 画框：有圆角（不是 0）、和场景图同比例铺满窗口（物理 480×270 = 1672:941，不留空白条）
  const frameRatio = dom.frame.w / dom.frame.h;
  const okFrame = dom.frame.r !== "0px" && dom.frame.w > 0 && Math.abs(frameRatio - 1672 / 941) < 0.02;
  const okNoDots = dom.noDots === 0;
  // done 会话（pi-2，expr=done）→ 素材降级到通用 done.png 且加载成功（不隐藏）
  const doneSeat = dom.avatars.find((a) => a.expr === "done");
  const okDoneFallback = doneSeat && !doneSeat.hidden && doneSeat.src.includes("/done.png");
  // 其余会话走 <agent>-<状态>.png → <状态>.png → <agent>.png 回落链，现在素材齐了，一个都不该隐藏
  const okAvatarFallback = dom.avatars.every((a) => a.hidden !== true && a.src.length > 0);
  console.log(`CHECK count=${okCount} bg=${okBg} pos=${okPos} frame=${okFrame} noDots=${okNoDots} doneFallback=${okDoneFallback} avatarFallback=${okAvatarFallback}`);

  const shot = await win.webContents.capturePage();
  writeFileSync(join(root, "seats.png"), shot.toPNG());
  console.log("SHOT_SAVED=" + join(root, "seats.png"));

  // 点第一个座位（排序后第一个 = 优先级最高的会话，这里是 error 的 hermes）→ focusAgent
  await win.webContents.executeJavaScript("document.querySelector('.seat-filled').click();");
  await new Promise((r) => setTimeout(r, 200));
  const clickOk = capturedHint && capturedHint.agent === "hermes";
  console.log("CLICK_HINT=" + JSON.stringify(capturedHint) + " ok=" + clickOk);

  // 面板弹出时背景+座位让位
  hub.publish(ev("permission.requested", "pi", "pi-3", Date.now(), { requestId: "req-x", interaction: { mode: "permission", title: "允许吗", providerRequestId: "req-x", prompts: [{ id: "p", question: "允许吗？", options: [{ id: "a", label: "允许" }], multiple: false, allowCustomInput: false }], responseCapability: true, responseStatus: "pending" } }));
  win.webContents.send("hub:snapshot", hub.snapshot());
  await new Promise((r) => setTimeout(r, 400));
  const panelState = await win.webContents.executeJavaScript("({ panelHidden: document.querySelector('#interaction-panel').hidden, frameDisplay: getComputedStyle(document.querySelector('.scene-frame')).display, seatsDisplay: getComputedStyle(document.querySelector('#agent-seats')).display })");
  const hideOk = !panelState.panelHidden && panelState.frameDisplay === "none" && panelState.seatsDisplay === "none";
  console.log("PANEL_HIDE=" + JSON.stringify(panelState) + " ok=" + hideOk);

  destroyPetWindow();
  app.exit(okCount && okBg && okPos && okFrame && okNoDots && okDoneFallback && okAvatarFallback && clickOk && hideOk ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
