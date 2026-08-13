// 排队测试：连发 3 个 pending（不同会话），验证处理完一个自动弹下一个
const { randomUUID, randomBytes } = require("node:crypto");
const { LocalIpcClient } = require("./dist/channel/ipc-client.js");

const client = new LocalIpcClient();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvent(sessionId, title, summary, question) {
  const now = Date.now();
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: `desktop-sim:${process.pid}:${randomBytes(5).toString("hex")}`,
    sequence: Math.floor(now / 1000),
    emittedAt: Date.now(),
    agent: "pi",
    sessionId,
    kind: "permission.requested",
    project: "排队测试",
    title,
    summary,
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
      responseCapability: false,
      responseStatus: "pending",
    },
  };
}

async function main() {
  const events = [
    makeEvent("sim-queue-1", "第 1 件 · 允许修改索引吗？", "Pi 请求修改事件索引", "第 1 件要处理的事，点按钮进入下一件"),
    makeEvent("sim-queue-2", "第 2 件 · 允许运行测试吗？", "Pi 请求运行项目测试", "第 2 件要处理的事"),
    makeEvent("sim-queue-3", "第 3 件 · 允许重启服务吗？", "Pi 请求重启本地服务", "第 3 件（最后一件）"),
  ];
  for (let i = 0; i < events.length; i += 1) {
    const result = await client.publish(events[i]);
    console.log(`[${i + 1}/3] 已发 ${events[i].title} -> ${JSON.stringify(result)}`);
    await delay(1500);
  }
  console.log("ALL_SENT_3_PENDING");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
