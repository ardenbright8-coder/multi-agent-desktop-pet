// 临时模拟：依次发 权限窗 / 选择窗 / 完成通知窗 三组事件（间隔 8 秒）
// 全部 responseCapability:false —— 按钮是「知道了，返回终端」，点了立即收起并切窗口，不等回传不卡住。
const { randomUUID, randomBytes } = require("node:crypto");
const { LocalIpcClient } = require("./dist/channel/ipc-client.js");

const client = new LocalIpcClient();
const now = Date.now();

function base(agent, kind, sessionId, extra) {
  return {
    version: 1,
    eventId: randomUUID(),
    sourceInstance: `desktop-sim:${process.pid}:${randomBytes(5).toString("hex")}`,
    sequence: Math.floor(now / 1000),
    emittedAt: Date.now(),
    agent,
    sessionId,
    kind,
    project: "模拟测试",
    title: "多 Agent 桌面宠物 · 模拟测试",
    ...extra,
  };
}

// 1. 权限申请窗口（agent=pi，返回终端 → 应切到 Pi Agent Desktop）
const permissionEvent = base("pi", "permission.requested", "sim-permission-pi", {
  summary: "Pi 请求修改事件索引并运行验证",
  reason: "现有索引缺少交互状态，需要写入模块才能完成这次实现",
  tool: "apply_patch",
  target: "src/events/event-index.ts",
  paths: ["src/events/event-index.ts"],
  requestId: randomUUID(),
  interaction: {
    mode: "permission",
    title: "允许 Pi 修改文件并运行测试吗？",
    providerRequestId: randomUUID(),
    prompts: [{
      id: "permission",
      question: "请选择这次权限范围",
      multiple: false,
      allowCustomInput: false,
      options: [
        { id: "once", label: "允许一次", value: "允许一次", description: "只执行当前这次修改和验证", recommended: true },
        { id: "reject", label: "拒绝", value: "拒绝", description: "不执行，Agent 返回原窗口等待" },
      ],
    }],
    recommendation: "允许一次，范围只覆盖列出的文件和测试",
    action: "修改文件并运行项目测试",
    resources: ["src/events/event-index.ts", "项目测试命令"],
    impact: "会改动一个源码文件并启动本地测试进程，不删除文件。",
    rollback: "源码有 Git 时可以回退；测试进程结束后不常驻。",
    unknowns: "测试耗时还没核实",
    responseCapability: false,
    responseStatus: "pending",
  },
});

// 2. 选择申请窗口（agent=claude-code，返回终端 → 找 claude 窗口）
const questionEvent = base("claude-code", "question.asked", "sim-question-claude", {
  summary: "Claude Code 正在确定长内容在面板里的呈现方式",
  reason: "长说明必须保持可读，同时底部操作不能被滚出窗口",
  tool: "question",
  target: "面板内容较长时采用哪种布局",
  requestId: randomUUID(),
  interaction: {
    mode: "question",
    title: "长内容应该怎么滚动？",
    providerRequestId: randomUUID(),
    prompts: [{
      id: "layout",
      question: "面板内容超过一屏时，操作区应该放在哪里？",
      multiple: false,
      allowCustomInput: true,
      options: [
        { id: "sticky", label: "固定底部操作", value: "固定底部操作", description: "正文单独滚动，关闭和确认始终可用", recommended: true },
        { id: "all-scroll", label: "整页一起滚动", value: "整页一起滚动", description: "结构简单，但长内容时要滚到底才能操作" },
      ],
    }],
    recommendation: "固定底部操作，长说明只在正文区域滚动",
    impact: "只影响面板布局和操作可达性，不改 Agent 原始选项。",
    responseCapability: false,
    responseStatus: "pending",
  },
});

// 3. 完成通知窗口（agent=pi，task.completed → 回原窗口切 Pi Agent Desktop）
const completeEvent = base("pi", "task.completed", "sim-complete-pi", {
  summary: "任务已经完成，可以回来查看",
  reason: "Pi 已完成这一轮模拟任务",
});

async function main() {
  const events = [permissionEvent, questionEvent, completeEvent];
  const names = ["权限申请窗口", "选择申请窗口", "完成通知窗口"];
  for (let i = 0; i < events.length; i += 1) {
    const result = await client.publish(events[i]);
    console.log(`[${new Date().toLocaleTimeString()}] 已发 ${names[i]} (agent=${events[i].agent}) -> ${JSON.stringify(result)}`);
    if (i < events.length - 1) await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  console.log("ALL_SENT");
  process.exit(0);
}

main().catch((error) => { console.error("FAIL", error); process.exit(1); });
