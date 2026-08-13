// 测试 focus-agent 修复：发一个带 originPid 的权限窗（agent=pi），验证"返回终端"能切到 pi 的窗口
const { randomUUID, randomBytes } = require("node:crypto");
const { LocalIpcClient } = require("./dist/channel/ipc-client.js");

const client = new LocalIpcClient();
const now = Date.now();

const event = {
  version: 1,
  eventId: randomUUID(),
  sourceInstance: `desktop-sim:${process.pid}:${randomBytes(5).toString("hex")}`,
  sequence: Math.floor(now / 1000),
  emittedAt: Date.now(),
  agent: "pi",
  sessionId: "sim-focus-test",
  kind: "permission.requested",
  project: "返回终端测试",
  title: "多 Agent 桌面宠物 · 返回终端测试",
  summary: "Pi 请求执行一次模拟操作",
  reason: "验证「返回终端」能切回 Pi 的窗口",
  tool: "apply_patch",
  target: "src/events/event-index.ts",
  paths: ["src/events/event-index.ts"],
  originPid: 14816, // 当前 pi 进程，focus-agent 会沿它的父进程链找窗口
  requestId: randomUUID(),
  interaction: {
    mode: "permission",
    title: "允许 Pi 执行这次模拟操作吗？",
    providerRequestId: randomUUID(),
    prompts: [{
      id: "permission",
      question: "请选择这次权限范围",
      multiple: false,
      allowCustomInput: false,
      options: [
        { id: "once", label: "允许一次", value: "允许一次", description: "只执行当前这次模拟操作", recommended: true },
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

client.publish(event)
  .then((result) => { console.log("SENT", JSON.stringify(result)); process.exit(0); })
  .catch((error) => { console.error("FAIL", error.message); process.exit(1); });
