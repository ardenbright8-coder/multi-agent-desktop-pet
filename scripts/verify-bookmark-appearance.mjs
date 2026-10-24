// 书签看板「透明度设置」后台驱动验证（Playwright·零抢鼠标）。
// 验证点：①左下角设置按钮点开浮层 ②拖滑条 CSS 变量实时变+数值显示 ③防抖落盘 appearance.json 值对 ④坏档回落默认 0.6。
// 用法：node scripts/verify-bookmark-appearance.mjs（独立 AGENT_PET_HUB_HOME，不碰真库）。

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const hubHome = mkdtempSync(join(tmpdir(), "bm-appearance-verify-"));
const appearancePath = join(hubHome, "bookmark", "appearance.json");
let electronApp;
try {
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: hubHome },
  });
  const panel = await waitFor(async () => {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) return win;
    }
    return null;
  });
  if (!panel) throw new Error("书签面板窗口没出现");
  await panel.waitForLoadState("domcontentloaded");

  // ④ 无存档启动：CSS 变量 = 默认 0.6（用户嫌 0.72 太实，改版默认调淡）。
  const initialAlpha = await panel.evaluate(() =>
    document.documentElement.style.getPropertyValue("--bm-alpha") || getComputedStyle(document.documentElement).getPropertyValue("--bm-alpha") || "",
  );
  check("④ 无存档启动用默认透明度 0.6", Number(initialAlpha) === 0.6, `--bm-alpha=${initialAlpha}`);

  // ① 点左下角设置按钮 → 浮层出现；再点外部 → 关闭。
  await panel.locator("#settings-btn").click();
  const popoverShown = await panel.evaluate(() => !document.getElementById("settings-popover")?.hidden);
  check("① 点 ⚙ 设置浮层出现", popoverShown === true);

  // ② 拖滑条（fill 直接设值+触发 input）：CSS 变量实时跟着变，数值显示 42%。
  await panel.locator("#opacity-slider").fill("0.42");
  await panel.locator("#opacity-slider").dispatchEvent("input");
  const alphaAfterSlide = await panel.evaluate(() => ({
    alpha: document.documentElement.style.getPropertyValue("--bm-alpha"),
    readout: document.getElementById("opacity-value")?.textContent ?? "",
  }));
  check("② 拖滑条 CSS 变量实时变", Number(alphaAfterSlide.alpha) === 0.42, `--bm-alpha=${alphaAfterSlide.alpha}`);
  check("② 数值显示 42%", alphaAfterSlide.readout === "42%", `显示=${alphaAfterSlide.readout}`);

  // ③ 防抖 0.5s 后落盘：appearance.json 里 opacity=0.42。
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(appearancePath, "utf8")).opacity === 0.42;
    } catch {
      return false;
    }
  }, 4000);
  const saved = JSON.parse(readFileSync(appearancePath, "utf8"));
  check("③ 防抖落盘 appearance.json 值对", saved.opacity === 0.42, `盘上=${saved.opacity}`);

  // ④ 坏档回落：写垃圾进 appearance.json，重启后回到 0.6。
  await electronApp.close();
  writeFileSync(appearancePath, "这不是JSON", "utf8");
  electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [appEntry],
    env: { ...process.env, AGENT_PET_ISOLATED: "1", AGENT_PET_HUB_HOME: hubHome },
  });
  const panel2 = await waitFor(async () => {
    for (const win of electronApp.windows()) {
      if ((win.url() || "").includes("bookmark/renderer")) return win;
    }
    return null;
  });
  if (!panel2) throw new Error("坏档重启后面板窗口没出现");
  await panel2.waitForLoadState("domcontentloaded");
  await waitFor(async () => {
    const alpha = await panel2.evaluate(() => document.documentElement.style.getPropertyValue("--bm-alpha"));
    return Number(alpha) === 0.6;
  }, 6000);
  const alphaAfterBadFile = await panel2.evaluate(() => document.documentElement.style.getPropertyValue("--bm-alpha"));
  check("④ 坏档重启回落默认 0.6", Number(alphaAfterBadFile) === 0.6, `--bm-alpha=${alphaAfterBadFile}`);

  // 点外面关闭浮层（补验）。
  await panel2.locator("#settings-btn").click();
  await panel2.locator("#board").click({ position: { x: 200, y: 200 } });
  const popoverClosed = await panel2.evaluate(() => document.getElementById("settings-popover")?.hidden);
  check("① 点浮层外面关闭", popoverClosed === true);
} catch (error) {
  failures.push(`脚本异常：${error?.message ?? error}`);
  console.error("脚本异常：", error);
} finally {
  try { await electronApp?.close(); } catch { /* 关不掉就算了 */ }
  try { rmSync(hubHome, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
}

if (failures.length) {
  console.error(`\n结果：${failures.length} 项没过 → ${failures.join("；")}`);
  process.exit(1);
}
console.log("\n结果：全部验证点通过");
