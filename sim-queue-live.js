// 排队测试 v2：3 个带确认按钮的 pending + 假接收者（用户点确认 → 秒交回 → 自动弹下一个）
const { randomUUID, randomBytes } = require("node:crypto");
const { LocalIpcClient } = require("./dist/channel/ipc-client.js");

const client = new LocalIpcClient();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvent(sessionId, title, question) {
  const now = Date.now();
  const sourceInstance = `desktop-sim:${process.pid}:${randomBytes(5).toString("hex")}`;
  return {
    sourceInstance,
    event: {
      version: 1,
      eventId: randomUUID(),
      sourceInstance,
      sequence: Math.floor(now / 1000),
      emittedAt: Date.now(),
      agent: "pi",
      sessionId,
      kind: "permission.requested",
      project: "排队测试v2",
      title,
      summary: `Pi 请求：${title}`,
      reason: "排队逐个处理测试",
      tool: "apply_patch",
      target: "src/events/event-index.ts",
      paths: ["src/events/event-index.ts"],
      originPid: 14816,
      requestId: randomUUID(),
      interaction: {
        mode: "permission",
        title,
        providerRequestId: randomUUID(),
        prompts: [{
          id: "permission",
          question,
          multiple: false,
          allowCustomInput: true,
          options: [
            { id: "once", label: "允许一次", value: "允许一次", description: "只执行当前这次操作", recommended: true },
            { id: "reject", label: "拒绝", value: "拒绝", description: "不执行，返回原窗口" },
          ],
        }],
        recommendation: "允许一次",
        action: "执行一次模拟操作",
        resources: ["模拟资源"],
        impact: "不会改动任何真实文件。",
        rollback: "无副作用。",
        unknowns: "无",
        responseCapability: true,
        responseStatus: "pending",
      },
    },
  };
}

async function main() {
  const items = [
    makeEvent("sim-q2-1", "第 1 件 · 允许修改索引吗？", "第 1 件要处理的事，点确认进入下一件"),
    makeEvent("sim-q2-2", "第 2 件 · 允许运行测试吗？", "第 2 件要处理的事"),
    makeEvent("sim-q2-3", "第 3 件 · 允许重启服务吗？", "第 3 件（最后一件）"),
  ];
  // 发事件
  for (let i = 0; i < items.length; i += 1) {
    const result = await client.publish(items[i].event);
    console.log(`[${i + 1}/3] 已发 ${items[i].event.title} -> ${JSON.stringify(result)}`);
    await delay(800);
  }
  // 假接收者：轮询 claim，接走用户点的确认并 complete
  const done = new Set();
  const claimed = new Set();
  const timer = setInterval(async () => {
    for (const item of items) {
      const evt = item.event;
      if (done.has(evt.eventId)) continue;
      try {
        const claim = await client.claimInteraction({
          eventId: evt.eventId,
          agent: evt.agent,
          sessionId: evt.sessionId,
          providerRequestId: evt.interaction.providerRequestId,
          sourceInstance: item.sourceInstance,
        });
        if (claim) {
          claimed.add(evt.eventId);
          await client.completeInteraction(claim.responseId, claim.claimToken, true);
          done.add(evt.eventId);
          console.log(`[${new Date().toLocaleTimeString()}] 假接收者接走并交回: ${evt.title}`);
        }
      } catch { /* 还没提交，继续等 */ }
    }
    if (done.size >= items.length) {
      clearInterval(timer);
      console.log("ALL_3_DONE");
      process.exit(0);
    }
  }, 500);
  // 90 秒兜底退出
  setTimeout(() => { console.log("TIMEOUT_90S done=" + done.size); process.exit(0); }, 90000);
}

main().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
