// 📁 项目文件夹（第三页签）的后台驱动验证（Playwright·零抢鼠标）。
// 验证点：①第三页签存在且默认非激活 ②切页后面包屑+新建钮 ③建项目夹真实落盘 ④单击进入子夹
//        ⑤子夹建 md（自动补后缀+标题行）⑥悬停文件夹自动弹目录预览 ⑦返回上一级 ⑧越界名字报错不上墙。
// 🚨 隔离铁律（2026-09-11 调度补充）：只对独立 AGENT_PET_HUB_HOME 的隔离实例操作；
//    _electron.launch 的 windows() 只含本进程窗口，天然碰不到用户主实例；
//    全程严禁对主实例发 F3/hide/show；测完只做一次主实例看板状态检查，发现被收起才用 Win32 SW_SHOW 帮恢复（调度授权的例外）。
// 用法：node scripts/verify-bookmark-projects.mjs

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");

const projectRoot = resolve(import.meta.dirname, "..");
const electronExe = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const appEntry = join(projectRoot, "dist", "app.js");

const failures = [];
function check(name, ok, detail = "") {
  const mark = ok ? "✔" : "✘";
  console.log(`${mark} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failures.push(name);
}

async function waitFor(fn, timeoutMs = 8000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

const hubHome = mkdtempSync(join(tmpdir(), "bm-proj-verify-"));
let electronApp;
try {
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_HUB_HOME: hubHome },
  });
  // 多窗口应用：按 URL 挑书签面板（隔离实例自己的窗口，碰不到主实例）。
  let panel = null;
  for (let i = 0; i < 40 && !panel; i += 1) {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) { panel = win; break; }
    }
    if (!panel) await new Promise((r) => setTimeout(r, 100));
  }
  if (!panel) throw new Error("书签面板窗口没出现");
  await panel.waitForLoadState("domcontentloaded");

  // ① 第三页签存在、默认非激活（默认页还是待定）。
  const tabs0 = await panel.evaluate(() => ({
    projectsTab: !!document.getElementById("tab-projects"),
    projectsActive: document.getElementById("tab-projects")?.classList.contains("active") ?? false,
    inboxActive: document.getElementById("tab-inbox")?.classList.contains("active") ?? false,
  }));
  check("① 第三页签「📁 项目」存在且默认非激活", tabs0.projectsTab && !tabs0.projectsActive && tabs0.inboxActive,
    JSON.stringify(tabs0));

  // ② 切到项目页：面包屑 + 新建两钮。
  await panel.locator("#tab-projects").click();
  const projBar = await waitFor(async () => {
    const state = await panel.evaluate(() => ({
      active: document.getElementById("tab-projects")?.classList.contains("active") ?? false,
      crumbs: document.querySelector(".proj-crumbs")?.textContent ?? "",
      newBtns: document.querySelectorAll(".proj-new-btn").length,
    }));
    return state.active && state.newBtns === 2 ? state : null;
  });
  check("② 切到项目页：面包屑在根、新建两钮都在", !!projBar && projBar.crumbs.includes("📁 项目"),
    JSON.stringify(projBar));

  // ③ 新建项目夹「毕业旅行」→ 列表出现 + 真实落盘。
  await panel.locator(".proj-new-btn", { hasText: "新建项目夹" }).click();
  await panel.locator(".proj-new-row input").fill("毕业旅行");
  await panel.locator(".proj-new-ok").click();
  const rowAppeared = await waitFor(async () => {
    return panel.evaluate(() => !!document.querySelector('.proj-row.is-dir[data-rel="毕业旅行"]'));
  });
  const dirOnDisk = existsSync(join(hubHome, "bookmark", "projects", "毕业旅行"));
  check("③ 新建项目夹后列表出现该夹", rowAppeared);
  check("③ 项目夹真实落盘（不是假数据）", dirOnDisk);

  // ⑤ 子夹里新建 md：自动补后缀 + 标题行。
  await panel.locator('.proj-row.is-dir[data-rel="毕业旅行"]').click();
  await waitFor(async () => {
    return panel.evaluate(() => (document.querySelector(".proj-crumbs")?.textContent ?? "").includes("毕业旅行"));
  });
  await panel.locator(".proj-new-btn", { hasText: "新建.md" }).click();
  await panel.locator(".proj-new-row input").fill("执行方案");
  await panel.locator(".proj-new-ok").click();
  const mdRow = await waitFor(async () => {
    return panel.evaluate(() => !!document.querySelector('.proj-row.is-file[data-rel="毕业旅行/执行方案.md"]'));
  });
  const mdPath = join(hubHome, "bookmark", "projects", "毕业旅行", "执行方案.md");
  const mdOnDisk = existsSync(mdPath) && readFileSync(mdPath, "utf8").startsWith("# 执行方案");
  check("⑤ 子夹建 md 后列表出现（rel 带子夹路径）", mdRow);
  check("⑤ md 真实落盘且内容带标题行", mdOnDisk);

  // ⑥ 悬停文件夹自动弹目录预览（不用点）：hover 根列表里那行——先返回上一级。
  await panel.locator(".proj-up").click();
  await waitFor(async () => {
    return panel.evaluate(() => !(document.querySelector(".proj-crumbs")?.textContent ?? "").includes("毕业旅行"));
  });
  await panel.locator('.proj-row.is-dir[data-rel="毕业旅行"]').hover();
  await panel.waitForTimeout(700); // 悬停 500ms 延迟 + 余量
  const pop = await panel.evaluate(() => {
    const p = document.getElementById("proj-pop");
    return { visible: !!p && !p.hidden, text: p?.textContent ?? "" };
  });
  check("⑥ 悬停文件夹自动弹目录预览（含子夹里的 md）",
    pop.visible && pop.text.includes("执行方案.md"), JSON.stringify(pop));

  // ⑦ 返回上一级按钮工作（已在⑥前验过一次，这里验根上不显示返回钮）。
  const noUpAtRoot = await panel.evaluate(() => !document.querySelector(".proj-up"));
  check("⑦ 根目录没有「⬅ 上一级」钮", noUpAtRoot);

  // ⑧ 非法名字不进盘：填 ".." → 主进程拒绝 → 列表不出现新夹。
  await panel.locator(".proj-new-btn", { hasText: "新建项目夹" }).click();
  await panel.locator(".proj-new-row input").fill("..");
  await panel.locator(".proj-new-ok").click();
  await panel.waitForTimeout(300);
  const rejected = await panel.evaluate(() => !document.querySelector('.proj-row.is-dir[data-rel=".."]'));
  check("⑧ 非法名字「..」被拒（不落盘不上墙）", rejected);
} catch (error) {
  failures.push(`脚本异常：${error?.message ?? error}`);
  console.error("脚本异常：", error);
} finally {
  try { await electronApp?.close(); } catch { /* 关不掉就算了 */ }
  await checkMainPanelAndRestore();
  try { rmSync(hubHome, { recursive: true, force: true }); } catch { /* 临时目录清理失败无妨 */ }
}

/** 约束第3条：测完检查用户主实例的看板窗口；发现被收起（不可见）才用 Win32 SW_SHOW 帮恢复。
 *  实现走 PowerShell（FindWindowW 带 Unicode 标题，之前诊断实测能拿到；koffi 传中文标题编码有坑）。
 *  绝不对主实例做其他窗口状态操作；恢复不了就如实报告（用户按 F3 也能自己开）。 */
async function checkMainPanelAndRestore() {
  try {
    // PowerShell 5.1 读无 BOM 的中文会乱码——写入时带 BOM（套餐里踩过的坑）。
    const ps1 = join(tmpdir(), `bm-proj-restore-${process.pid}.ps1`);
    const script = `
$sig = @"
using System;
using System.Runtime.InteropServices;
public class BMWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static string Check() {
    IntPtr h = FindWindowW(null, "Agent 看板");
    if (h == IntPtr.Zero) return "NOTFOUND";
    if (IsWindowVisible(h)) return "VISIBLE";
    ShowWindow(h, 5);
    return IsWindowVisible(h) ? "RESTORED" : "RESTORE_FAILED";
  }
}
"@
Add-Type -TypeDefinition $sig
[BMWin]::Check()
`;
    writeFileSync(ps1, "\uFEFF" + script, "utf8");
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8", timeout: 20000 }).trim();
    if (out === "NOTFOUND") console.log("ℹ 主实例看板窗口未找到（可能桌宠没跑），跳过恢复检查");
    else if (out === "VISIBLE") console.log("ℹ 主实例看板窗口可见，无需恢复");
    else if (out === "RESTORED") console.log("✔ 主实例看板处于收起态，已用 Win32 SW_SHOW 帮恢复");
    else {
      console.log("✘ 主实例看板处于收起态且恢复失败（用户按 F3 即可开）");
      failures.push("主实例看板恢复失败");
    }
  } catch (error) {
    console.log(`ℹ 主实例恢复检查跳过（调用失败：${error?.message ?? error}）`);
  }
}

if (failures.length) {
  console.error(`\n结果：${failures.length} 项没过 → ${failures.join("；")}`);
  process.exit(1);
}
console.log("\n结果：全部验证点通过");
