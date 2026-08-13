// 发一个权限窗（agent=pi, originPid=当前 pi 进程），测试"返回终端"延迟
const { randomUUID, randomBytes } = require("node:crypto");
const { LocalIpcClient } = require("./dist/channel/ipc-client.js");

// 找到当前 pi 的 node 进程（命令行含 pi-coding-agent 的 cli.js）
const { execFileSync } = require("node:child_process");
let originPid = 0;
try {
  const rows = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*pi-coding-agent*' } | Select-Object -First 1 -ExpandProperty ProcessId"
  ], { encoding: "utf8", timeout: 20000 }).trim();
  originPid = Number(rows) || 0;
} catch { originPid = 0; }
if (!originPid) { console.error("NO_PI_PID"); process.exit(1); }

const client = new LocalIpcClient();
const now = Date.now();
const event = {
  version: 1,
  eventId: randomUUID(),
  sourceInstance: `desktop-sim:${process.pid}:${randomBytes(5).toString("hex")}`,
  sequence: Math.floor(now / 1000),
  emittedAt: Date.now(),
  agent: "pi",
  sessionId: "sim-latency-test",
  kind: "permission.requested",
  project: "延迟测试",
  title: "多 Agent 桌面宠物 · 延迟测试",
  summary: "Pi 请求执行一次模拟操作",
  reason: "测量「返回终端」的延迟",
  tool: "apply_patch",
  target: "src/events/event-index.ts",
  paths: ["src/events/event-index.ts"],
  originPid,
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
  .then((result) => { console.log("SENT originPid=" + originPid + " " + JSON.stringify(result)); process.exit(0); })
  .catch((error) => { console.error("FAIL", error.message); process.exit(1); });
