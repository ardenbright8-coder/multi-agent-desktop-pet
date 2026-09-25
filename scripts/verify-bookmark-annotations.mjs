// 隔离 Electron 看板：隐藏窗口里验证图片标注（设定16第三版）——打开大图就能标、编号 / 框 / 箭头一套流水号、
// 说明写在图下面、自动存（不烧原图，另存带编号的图）、撤销、拖动编号、删光回原样、改字框里也能标、交给 AI 带编号清单。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");
const root = resolve(import.meta.dirname, "..");
const runs = join(root, ".runtime", "annotation-tests");
mkdirSync(runs, { recursive: true });
const home = mkdtempSync(join(runs, "run-"));
const attachments = join(home, "bookmark", "attachments");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, what) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`等不到：${what}`);
}
const marksOnDisk = (name) => {
  const path = join(attachments, `${name}.marks.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).marks : null;
};
const summaryOnDisk = (name) => {
  const path = join(attachments, `${name}.marks.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).summary : null;
};

let app;
try {
  app = await _electron.launch({
    executablePath: join(root, "node_modules/electron/dist/electron.exe"),
    args: [join(root, "scripts/bookmark-image-test-host.cjs")],
    env: { ...process.env, AGENT_PET_HUB_HOME: home, AGENT_PET_SKIP_INTEGRATION_INSTALL: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // 在大图的标注层上按下 / 挪 / 松手；坐标是占图片宽高的比例。
  await page.evaluate(() => {
    window.bmTestDrag = (from, to) => {
      const layer = document.querySelector("dialog[open] .bm-mark-layer");
      layer.setPointerCapture = () => {};
      const rect = document.querySelector("dialog[open] .bm-mark-stage img").getBoundingClientRect();
      const fire = (type, [x, y]) => layer.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height }));
      fire("pointerdown", from); fire("pointermove", to); fire("pointerup", to);
    };
    window.bmTestTool = (label) => [...document.querySelectorAll("dialog[open] .bm-mark-tools [data-tool]")].find((b) => b.textContent.includes(label)).click();
  });
  const openViewer = async (selector) => {
    await page.evaluate((selector) => document.querySelector(selector).click(), selector);
    await page.waitForFunction(() => document.querySelector("dialog[open] .bm-mark-stage img")?.naturalWidth === 200 && document.querySelector("dialog[open] .bm-mark-layer")?.width > 0);
    await page.waitForFunction(() => !!document.querySelector("dialog[open] .bm-mark-notes li"));
  };

  const name = await page.evaluate(async () => {
    const image = document.createElement("canvas"); image.width = 200; image.height = 120;
    const context = image.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 200, 120);
    const blob = await new Promise((resolve) => image.toBlob(resolve, "image/png"));
    const name = await window.bookmark.saveImage(new Uint8Array(await blob.arrayBuffer()));
    await window.bookmark.add({ text: `请看这里 [图片:${name}] 再处理`, assignee: "Claude" });
    document.getElementById("tab-groups").click();
    await bmRefresh();
    return name;
  });
  const original = readFileSync(join(attachments, name));

  // ① 打开大图就能标：没有「标注图片」「保存」按钮，工具只有编号 / 框 / 箭头 + 撤销
  await openViewer('.group[data-group="Claude"] .task-text .bm-inline-image button');
  const ui = await page.evaluate(() => ({
    tools: [...document.querySelectorAll("dialog[open] .bm-mark-tools [data-tool]")].map((b) => b.textContent),
    buttons: [...document.querySelectorAll("dialog[open] button")].map((b) => b.textContent),
    empty: document.querySelector("dialog[open] .bm-mark-empty")?.textContent,
  }));
  assert.deepEqual(ui.tools, ["●标注", "▢框", "↗箭头"], JSON.stringify(ui));
  assert.ok(!ui.buttons.some((text) => /标注图片|保存/.test(text)), JSON.stringify(ui));
  assert.ok(ui.empty, "没标之前下面有一句怎么用");

  // ② 点一下落编号、光标跳到①的说明；框和箭头接着排 ②③
  await page.evaluate(() => window.bmTestDrag([0.2, 0.3], [0.2, 0.3]));
  await page.waitForFunction(() => document.activeElement?.closest?.(".bm-mark-notes li")?.dataset.index === "0");
  await page.evaluate(() => { const input = document.activeElement; input.value = "这个按钮改成绿色"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.evaluate(() => { window.bmTestTool("框"); window.bmTestDrag([0.5, 0.2], [0.8, 0.6]); });
  await page.evaluate(() => { window.bmTestTool("箭头"); window.bmTestDrag([0.1, 0.8], [0.6, 0.8]); });
  await page.evaluate(() => { const box = document.querySelector("dialog[open] .bm-mark-summary"); box.value = "整体再清爽一点"; box.dispatchEvent(new Event("input", { bubbles: true })); });
  const numbers = await page.evaluate(() => [...document.querySelectorAll("dialog[open] .bm-mark-num")].map((n) => n.textContent));
  assert.deepEqual(numbers, ["①", "②", "③"]);
  const saved = await until(() => marksOnDisk(name)?.length === 3 && marksOnDisk(name), "三个标注自动存盘");
  assert.deepEqual(saved.map((m) => m.kind), ["pin", "box", "arrow"]);
  assert.equal(saved[0].note, "这个按钮改成绿色");
  await until(() => summaryOnDisk(name) === "整体再清爽一点", "整体说明存盘");
  await until(() => existsSync(join(attachments, `${name}.marked.png`)), "带编号的图");
  assert.deepEqual(readFileSync(join(attachments, name)), original, "原图一个字节都不许动");

  // ③ 撤销去掉最后一个
  await page.evaluate(() => document.querySelector("dialog[open] .bm-mark-undo").click());
  await until(() => marksOnDisk(name)?.length === 2, "撤销后剩两个");

  // ④ 关掉再交给 AI：带编号的图＋原图＋清单，正文里的图片标记不换
  await page.evaluate(() => document.querySelector("dialog[open] .bm-image-close").click());
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  const handed = await page.evaluate(async () => {
    const record = (await window.bookmark.list())[0];
    return { text: record.text, prompt: await window.bookmark.copyForAgent(record.id, null) };
  });
  assert.ok(handed.text.includes(`[图片:${name}]`), "正文图片标记不换");
  assert.ok(handed.prompt.includes(`${name}.marked.png`) && handed.prompt.includes(`原图：`), handed.prompt);
  assert.ok(handed.prompt.includes("① 标注，大约在（从左 20%、从上 30%）这附近：这个按钮改成绿色"), handed.prompt);
  assert.ok(handed.prompt.includes("整张图的说明：整体再清爽一点"), handed.prompt);
  assert.ok(handed.prompt.includes("② 框") && !handed.prompt.includes("③"), handed.prompt);

  // ⑤ 重开还在；按住编号拖走；删光回原样
  await openViewer('.group[data-group="Claude"] .task-text .bm-inline-image button');
  const reopened = await page.evaluate(() => ({ notes: [...document.querySelectorAll("dialog[open] .bm-mark-notes input")].map((i) => i.value), summary: document.querySelector("dialog[open] .bm-mark-summary").value }));
  assert.deepEqual(reopened, { notes: ["这个按钮改成绿色", ""], summary: "整体再清爽一点" });
  await page.evaluate(() => window.bmTestDrag([0.2, 0.3], [0.35, 0.45]));
  await until(() => Math.abs((marksOnDisk(name)?.[0]?.x ?? 0) - 0.35) < 0.01, "拖动编号后位置存上");
  await page.evaluate(() => { document.querySelector("dialog[open] .bm-mark-del").click(); });
  await page.evaluate(() => { document.querySelector("dialog[open] .bm-mark-del").click(); });
  // 标注删光、整体说明还在：留说明，不留带编号的图
  await until(() => marksOnDisk(name)?.length === 0 && !existsSync(join(attachments, `${name}.marked.png`)), "标注删光后只剩整体说明");
  const summaryOnly = await page.evaluate(async () => window.bookmark.copyForAgent((await window.bookmark.list())[0].id, null));
  assert.ok(summaryOnly.includes("整张图的说明：整体再清爽一点") && !summaryOnly.includes(".marked.png"), summaryOnly);
  await page.evaluate(() => { const box = document.querySelector("dialog[open] .bm-mark-summary"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); });
  await until(() => !existsSync(join(attachments, `${name}.marks.json`)) && !existsSync(join(attachments, `${name}.marked.png`)), "说明也清空后两个附属文件都清掉");
  await page.evaluate(() => document.querySelector("dialog[open] .bm-image-close").click());
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  const plain = await page.evaluate(async () => window.bookmark.copyForAgent((await window.bookmark.list())[0].id, null));
  assert.ok(!plain.includes("标了") && !plain.includes(".marked.png"), plain);

  // ⑥ 改字框里点小图也能标，关掉以后改字框还在
  await page.evaluate(() => document.querySelector(".task-text").click());
  await page.waitForSelector(".bm-rich-input .bm-inline-image", { state: "attached" });
  await openViewer(".bm-rich-input .bm-inline-image button");
  await page.evaluate(() => window.bmTestDrag([0.5, 0.5], [0.5, 0.5]));
  await page.evaluate(() => document.querySelector("dialog[open] .bm-image-close").click());
  await until(() => marksOnDisk(name)?.length === 1, "改字框里标的也存上（关窗马上存）");
  assert.ok(await page.evaluate(() => !!document.querySelector(".bm-rich-input")?.isConnected), "关掉大图后改字框还在");

  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false);
  console.log("PASS 打开就能标、标注框箭头一套流水号、整体说明、说明写在下面、自动存不动原图、撤销、拖动编号、删光回原样、改字框里能标、交给 AI 带编号清单；测试窗口始终隐藏");
} finally {
  await app?.close();
}
