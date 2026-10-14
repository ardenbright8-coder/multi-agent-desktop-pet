#!/usr/bin/env node
// ---
// 这是啥: Agent 看板命令行——AI agent 用它往看板写任务/结果、领任务（2026-09-10 用户拍板 CLI 接入）
// 谁看: 任何能跑 node 命令的 AI agent / 人；用法文档在仓库根 AGENT_INTEGRATION.md「书签看板 CLI」节
// 什么时候用: agent 干完活报结果、开工前领任务；每次调用一个短进程，用完即退（零常驻）
// 改之前必看: 数据走主进程内的服务（绝不直写 bookmarks.json，主进程内存会覆盖直写）；
//   桌宠没运行时读不到 cli-port.json 或连接被拒，直接报「看板没开」退出码 1，不许挂死
// 前提: 桌宠仓 npm run build 过（本脚本读 dist 编译产物）；node 18+（自带 fetch）
// ---

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import cli from "../dist/bookmark/cli-server.js";

const appData = process.env.APPDATA || join(process.env.USERPROFILE ?? homedir(), "AppData", "Roaming");
const portFile = process.env.AGENT_PET_HUB_HOME
  ? join(process.env.AGENT_PET_HUB_HOME, "bookmark", "cli-port.json")
  : join(appData, "AgentPetHub", "bookmark", "cli-port.json");

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// 1. 参数解析（纯函数在 cli-server.ts，经 dist 复用——用法说明也归它管）
let args;
try {
  args = cli.parseCliArgs(process.argv.slice(2));
} catch (error) {
  die(`参数不对：${error?.message ?? error}`, 2);
}

// 2. 端口发现：桌宠没运行就短退出
if (!existsSync(portFile)) die("看板没开（桌宠没运行）。先把桌宠跑起来再用 CLI。");
let cfg;
try {
  // 剥 BOM：Windows 记事本/PowerShell 写的文件常带 BOM
  cfg = JSON.parse(readFileSync(portFile, "utf8").replace(/^\uFEFF/, ""));
} catch {
  die("看板没开（cli-port.json 坏档）。重启桌宠会自动重写。");
}
if (typeof cfg?.port !== "number" || typeof cfg?.token !== "string") {
  die("看板没开（cli-port.json 内容不对）。重启桌宠会自动重写。");
}

// 3. 请求（5 秒超时，绝不挂死）
const base = `http://127.0.0.1:${cfg.port}`;
let res;
try {
  if (args.command === 'dispatch') {
    const waiting = args.payload.action === 'wait';
    const end = Date.now() + (args.payload.seconds ?? 120) * 1000;
    do {
      res = await fetch(`${base}/dispatch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(waiting ? { ...args.payload, action: 'messages' } : args.payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!waiting || !res.ok) break;
      const pending = await res.clone().json();
      if (pending.notices?.length || Date.now() >= end) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, end - Date.now()))));
    } while (true);
  } else if (args.command === "add") {
    res = await fetch(`${base}/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ text: args.text, url: args.url ?? null, assignee: args.to ?? null, attach: args.attach ?? [] }),
      signal: AbortSignal.timeout(5_000),
    });
  } else if (args.command === "handoff") {
    res = await fetch(`${base}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ text: args.text, assignee: args.to ?? null, detail: args.detail ?? null }),
      signal: AbortSignal.timeout(5_000),
    });
  } else if (args.command === "next" || args.command === "done" || args.command === "release" || args.command === "report") {
    // 领活几件套（设定15、18）：next 领下一条（--to 按组领）/ done 用户说可以才删 / report 睡觉档写报告 / release 放回去
    const payload = args.command === "next"
      ? { target: args.target ?? null, group: args.to ?? null, by: args.by, coding: args.coding }
      : { id: args.target, by: args.by, ok: args.ok ?? "", text: args.text ?? "" };
    res = await fetch(`${base}/${args.command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } else if (args.command === "show" || (args.command === "list" && !args.json)) {
    // 按号码读（2026-10-13）：list 不带 --json 只列号码和标题；show 只吐点名那几条的全文
    const params = new URLSearchParams();
    if (args.command === "show") {
      params.set("mode", "show");
      params.set("group", args.group);
      params.set("spec", args.spec.join(" "));
    } else if (args.handoffOnly) params.set("group", "交接单");
    else if (args.to) params.set("group", args.to);
    res = await fetch(`${base}/view?${params.toString()}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(5_000),
    });
  } else if (args.command === "remove") {
    res = await fetch(`${base}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ id: args.id }),
      signal: AbortSignal.timeout(5_000),
    });
  } else {
    const params = new URLSearchParams();
    if (args.to) params.set("to", args.to);
    if (args.handoffOnly) params.set("handoff", "1");
    const query = params.size ? `?${params.toString()}` : "";
    res = await fetch(`${base}/list${query}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(5_000),
    });
  }
} catch (error) {
  const code = error?.cause?.code ?? error?.code ?? error?.message;
  die(`看板没开（桌宠没运行：${code}）。先把桌宠跑起来再用 CLI。`);
}

const data = await res.json().catch(() => ({}));
if (!res.ok || data?.ok === false) {
  die(`失败：${data?.error ?? `HTTP ${res.status}`}`);
}

// 4. 展示
if (args.command === 'dispatch') {
  if (args.payload.action === 'next' && !args.json) {
    const self = fileURLToPath(import.meta.url).split(String.fromCharCode(92)).join('/');
    console.log(cli.formatClaimMessage(data, { cli: self, by: args.payload.by, coding: false }));
  } else console.log(JSON.stringify(data, null, 2));
} else if (args.command === "add") {
  console.log(args.json ? JSON.stringify(data) : `✅ 已进看板（${data.id}）`);
} else if (args.command === "handoff") {
  console.log(args.json ? JSON.stringify(data) : `📋 交接单已写进看板（${data.id}）；接手的 AI 先 next 标在干，用户说完工再 done 消掉`);
} else if (args.command === "remove") {
  console.log(args.json ? JSON.stringify(data) : "✅ 已删");
} else if (args.command === "next") {
  // 规矩原文在 cli-server 的 formatClaimMessage，所有 AI 看到同一份；命令里的脚本路径用正斜杠，哪种终端都能直接粘。
  const self = fileURLToPath(import.meta.url).split(String.fromCharCode(92)).join("/");
  console.log(args.json ? JSON.stringify(data) : cli.formatClaimMessage(data, { cli: self, target: args.target, group: args.to, by: args.by, coding: args.coding }));
} else if (args.command === "done") {
  console.log(args.json ? JSON.stringify(data) : "✅ 这条干完了，已从看板删掉。接着按上面第 4 步 next 领下一条。");
} else if (args.command === "report") {
  const self = fileURLToPath(import.meta.url).split(String.fromCharCode(92)).join('/');
  const text = data.cooperation
    ? `报告已交给 ${data.coordinator}，原任务留待审核，整捆仍由你负责。继续只领本捆：node "${self}" next ${data.bundleId} --by "${args.by}"`
    : '✅ 报告挂上了，这条标成「干完待审」，等用户早上看。接着按上面第 3 步 next 领下一条。';
  console.log(args.json ? JSON.stringify(data) : text);
} else if (args.command === "release") {
  console.log(args.json ? JSON.stringify(data) : "↩️ 已放回去，别的窗口可以领了。");
} else if (args.command === "show" || !args.json) {
  console.log(data.text);
} else {
  console.log(JSON.stringify(data.items, null, 2));
}
