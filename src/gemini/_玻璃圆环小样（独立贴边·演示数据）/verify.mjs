// 公共 Playwright 后台驱动；只开本小样，测试位置隔离，不操作物理鼠标、不重建日常dist。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "../../..");
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");
const { dockOrb, panelBounds, nearestSide } = require("./geometry.cjs");
const runtime = join(root, ".runtime", "test-runs"); mkdirSync(runtime, { recursive: true });
const run = mkdtempSync(join(runtime, "bm-gemini-glass-"));
console.log("RUN " + run);
let assertions = 0;
function check(condition, message) { assert(condition, message); assertions++; }
function inside(bounds, area) { return bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width + 1 && bounds.y + bounds.height <= area.y + area.height + 1; }
const areas = [{ x: 0, y: 0, width: 1922, height: 778 }, { x: -1920, y: -200, width: 1920, height: 1080 }, { x: 0, y: 0, width: 800, height: 600 }];
for (const area of areas) for (const side of ["left", "right"]) for (const cy of [-9999, 0, 450, 9999]) {
  const orb = dockOrb(area, side, cy); check(inside(orb, area), "小球越过工作区");
  check(nearestSide(area, orb.x + orb.width / 2) === side, "左右吸附方向不符");
  for (const count of [1, 2, 3]) for (const mode of ["summary", "details"]) check(inside(panelBounds(area, orb, mode, count), area), "展开卡片越界");
}
function distHash() {
  return ["app.js", "gemini/gemini-quota.js", "gemini/renderer/quota.js"].map(name => {
    const f = join(root, "dist", name); return existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "absent";
  });
}
const before = distHash();
const electron = await _electron.launch({ executablePath: join(root, "node_modules", "electron", "dist", "electron.exe"),
  args: [join(here, "main.cjs"), "--preview-home=" + join(run, "home")],
  env: { ...process.env, GEMINI_GLASS_PREVIEW_TEST: "1" }, timeout: 30000 });
let errors = [], frameworkDiagnostics = [];
try {
  const first = await electron.firstWindow();
  await first.waitForFunction(() => document.querySelectorAll("#orbRings .ring-fill").length === 2);
  const pages = await electron.windows();
  const orb = pages.find(p => new URL(p.url()).searchParams.get("view") === "orb");
  const panel = pages.find(p => new URL(p.url()).searchParams.get("view") === "panel");
  check(!!orb && !!panel, "没有分别建立小球和详情窗口");
  for (const p of pages) p.on("pageerror", error => errors.push(error.stack || String(error)));
  await panel.waitForFunction(() => document.querySelectorAll(".account-row").length === 2);
  check(await orb.locator("#orbNumber").textContent() === "68", "常驻数字不是最低剩余");
  check(await panel.locator("#heroCaption").textContent() === "当前最低余量 · 2号", "中心数值的账号说明缺失");
  check(await orb.locator(".ring-fill").count() === 2, "初始圆环数量错误");
  check(await panel.locator("#details").isHidden(), "周额度泄露到常驻界面");
  check(await panel.locator("#summary").isVisible(), "摘要没有显示");
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("view=orb")).showInactive());
  await orb.mouse.move(33, 33);
  await orb.waitForFunction(() => document.body.dataset.expanded === "true");
  check(await orb.locator("#orbShell").evaluate(e => e.classList.contains("is-open")), "悬停后小球未放大");
  const initialWindows = await electron.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), focusable: w.isFocusable(), focused: w.isFocused(), bounds: w.getBounds(), area: screen.getDisplayMatching(w.getBounds()).workArea })));
  check(initialWindows.every(w => !w.focusable && !w.focused), "预览抢了输入焦点");
  check(initialWindows.every(w => insidePlain(w.bounds, w.area)), "真实窗口越界");
  function insidePlain(b, a) { return b.x >= a.x - 2 && b.y >= a.y - 2 && b.x + b.width <= a.x + a.width + 2 && b.y + b.height <= a.y + a.height + 2; }
  await orb.screenshot({ path: join(run, "v1_小球透明底.png"), omitBackground: true });
  await panel.screenshot({ path: join(run, "v1_双账号展开.png"), omitBackground: true });
  for (const count of [1, 3, 2]) {
    await panel.evaluate(n => window.glassPreview.count(n), count);
    await panel.waitForFunction(n => document.querySelectorAll(".account-row").length === n, count);
    check(await orb.locator(".ring-fill").count() === count, "增减账号后环数不符");
    const minimum = count === 1 ? "91" : count === 3 ? "37" : "68";
    check(await orb.locator("#orbNumber").textContent() === minimum, "增减账号后最低余量不符");
    const metrics = await panel.evaluate(() => {
      const root = document.querySelector(".panel-content"), r = root.getBoundingClientRect();
      return { overflow: root.scrollHeight - root.clientHeight, rows: [...document.querySelectorAll(".account-row")].map(el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }), top: r.top, bottom: r.bottom };
    });
    check(metrics.overflow <= 1 && metrics.rows.every(r => r.top >= metrics.top && r.bottom <= metrics.bottom), "账号文字溢出");
    if (count === 3) await panel.screenshot({ path: join(run, "v1_三账号展开.png"), omitBackground: true });
  }
  await orb.locator("#orb").click({ button: "right" });
  await panel.waitForFunction(() => document.body.dataset.mode === "details");
  check(await panel.locator("#details").isVisible(), "右键没有进入详情");
  check(await panel.locator("#detailNumber").textContent() === "68", "详情数值不是剩余");
  check(await panel.locator("#detailWeekly").textContent() === "55%", "周额度没有换算为剩余");
  check(await panel.locator(".not-connected").textContent() === "尚未接入", "虚构套餐余额");
  await panel.locator('[data-account="1号"]').click();
  check(await panel.locator("#detailNumber").textContent() === "91", "切换详情账号失效");
  await panel.locator('[data-count="3"]').click();
  await panel.waitForFunction(() => document.querySelectorAll(".account-tab").length === 3);
  await panel.locator('[data-account="3号"]').click();
  check(await panel.locator("#detailNumber").textContent() === "37", "三账号详情失效");
  const detailMetrics = await panel.locator(".panel-content").evaluate(e => ({ height: e.clientHeight, scroll: e.scrollHeight, font: getComputedStyle(document.querySelector(".detail-grid strong")).fontSize }));
  check(detailMetrics.scroll <= detailMetrics.height + 1, "详情卡片底部被裁切");
  check(parseFloat(detailMetrics.font) >= 14, "展开数值字号过小");
  await panel.screenshot({ path: join(run, "v1_详情透明底.png"), omitBackground: true });
  for (const side of ["left", "right"]) {
    await panel.locator('[data-action="' + side + '"]').click();
    await panel.waitForFunction(s => document.querySelector('.dock-controls [data-action="' + s + '"]').getAttribute("aria-pressed") === "true", side);
    const result = await electron.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("view=orb"));
      return { b: w.getBounds(), area: screen.getDisplayMatching(w.getBounds()).workArea };
    });
    check(nearestSide(result.area, result.b.x + result.b.width / 2) === side, "真实窗口吸附方向不符");
    check(insidePlain(result.b, result.area), "吸附后窗口越界");
  }
  await panel.locator('[data-action="back"]').click();
  await panel.locator('[data-action="details"]').click();
  await panel.waitForFunction(() => document.body.dataset.mode === "details");
  check(await panel.locator("#details").isVisible(), "详情按钮失效");
  await panel.locator('[data-action="back"]').click();
  await orb.mouse.move(0, 0); await panel.mouse.move(0, 0);
  await panel.waitForFunction(() => document.body.dataset.expanded === "false");
  const closedState = await panel.evaluate(() => window.glassPreview.get());
  check(closedState.visible === false, "离开后未自动收回");
  await orb.mouse.move(33, 33); await orb.mouse.down(); await orb.mouse.move(45, 33);
  await orb.waitForFunction(() => document.querySelector("#orbShell").classList.contains("is-dragging"));
  check((await orb.evaluate(() => window.glassPreview.get())).dragging, "拖动阈值没有启动独立窗口拖动");
  await orb.mouse.up();
  await orb.waitForFunction(() => !document.querySelector("#orbShell").classList.contains("is-dragging"));
  check(!(await orb.evaluate(() => window.glassPreview.get())).dragging, "松开后没有结束拖动");
  // Electron 43 的安全告警器把空资源计时名传给new URL，栈已从其内置源码核对。
  // 不关闭告警、沙箱或CSP；仅把这个已定位的框架诊断与本小样异常分开记。
  frameworkDiagnostics = errors.filter(error => error.startsWith("TypeError: Failed to construct 'URL': Invalid URL") && /at node:electron\/js2c\/sandbox_bundle:2:101097/.test(error));
  const ownErrors = errors.filter(error => !frameworkDiagnostics.includes(error));
  check(ownErrors.length === 0, ownErrors.join("\n"));
} finally { await electron.close(); }
check(JSON.stringify(before) === JSON.stringify(distHash()), "日常dist被改动");
check(!existsSync(join(run, "home", "receiver.json")), "小样意外启动了收件器");
const report = { assertions, passed: true, frameworkDiagnostics, physicalMouseTouched: false, realAccounts: false, userDistUntouched: true,
  disclaimer: "鼠标输入通过Playwright页面协议合成；贴边几何与窗口状态已验，主机真实手拖手感由用户看小样确认。", screenshots: run };
writeFileSync(join(run, "preview-ok.json"), JSON.stringify(report, null, 2));
console.log("GEMINI_GLASS_PREVIEW_OK assertions=" + assertions + " frameworkDiagnostics=" + frameworkDiagnostics.length);
console.log("REPORT " + run);
