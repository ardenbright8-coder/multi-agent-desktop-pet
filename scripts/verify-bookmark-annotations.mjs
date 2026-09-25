// 隔离 Electron 看板：在隐藏窗口里验证标注、存档和交给 AI 的图片路径。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");
const root = resolve(import.meta.dirname, "..");
const runs = join(root, ".runtime", "annotation-tests");
mkdirSync(runs, { recursive: true });
const home = mkdtempSync(join(runs, "run-"));
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
  const original = await page.evaluate(async () => {
    const image = document.createElement("canvas"); image.width = 200; image.height = 120;
    const context = image.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 200, 120);
    const blob = await new Promise((resolve) => image.toBlob(resolve, "image/png"));
    const name = await window.bookmark.saveImage(new Uint8Array(await blob.arrayBuffer()));
    await window.bookmark.add({ text: `请看这里 [图片:${name}] 再处理`, assignee: "Claude" });
    document.getElementById("tab-groups").click();
    await bmRefresh();
    document.querySelector('.group[data-group="Claude"] .task-text .bm-inline-image button').click();
    return name;
  });
  await page.waitForFunction(() => document.querySelector("dialog[open] img")?.naturalWidth === 200);
  await page.evaluate(() => {
    document.querySelector(".bm-image-annotate").click();
    const canvas = document.querySelector(".bm-annotation-canvas");
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const event = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height }));
    event("pointerdown", .2, .2); event("pointermove", .8, .7); event("pointerup", .8, .7);
    document.querySelector('.bm-annotation-tools button:last-child').click();
  });
  let changed = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    changed = await page.evaluate(async (original) => (await window.bookmark.list())[0]?.attachments[0] !== original, original);
    if (changed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(changed, JSON.stringify(await page.evaluate(() => ({error: document.querySelector("#board-error")?.textContent, dialog: !!document.querySelector("dialog[open]"), busy: bmImagesBusy}))));
  const result = await page.evaluate(async () => {
    const record = (await window.bookmark.list())[0];
    return { record, prompt: await window.bookmark.copyForAgent(record.id, null) };
  });
  assert.equal(result.record.attachments.length, 1);
  const current = result.record.attachments[0];
  assert.notEqual(current, original);
  assert.ok(result.record.text.includes(`[图片:${current}]`));
  assert.ok(result.prompt.includes(current) && !result.prompt.includes(original));
  assert.notDeepEqual(readFileSync(join(home, "bookmark", "attachments", current)), readFileSync(join(home, "bookmark", "attachments", original)));
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  await page.evaluate(() => {
    document.querySelector(".task-text").click();
  });
  await page.waitForSelector(".task-edit.bm-rich-input, .task-edit + .bm-rich-input, .bm-rich-input", { state: "attached" });
  await page.evaluate(() => {
    document.querySelector(".bm-rich-input .bm-inline-image button").click();
  });
  await page.waitForFunction(() => document.querySelector("dialog[open] img")?.naturalWidth === 200);
  await page.evaluate(() => {
    document.querySelector("dialog[open] .bm-image-annotate").click();
    const buttons = [...document.querySelectorAll('dialog[open] .bm-annotation-tools button')];
    buttons.find((button) => button.textContent === "文字").click();
    document.querySelector('dialog[open] .bm-annotation-tools input').value = "这里";
    const canvas = document.querySelector("dialog[open] .bm-annotation-canvas");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    buttons.find((button) => button.textContent === "保存标注").click();
  });
  let edited = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    edited = await page.evaluate((current) => !document.querySelector(".task-edit")?.value.includes(current), current);
    if (edited) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(edited, `改字框里的图片标记也应替换：${JSON.stringify(await page.evaluate(() => ({value: document.querySelector('.task-edit')?.value, busy: bmImagesBusy, editing: bmEditingId, error: document.querySelector('#board-error')?.textContent, dialog: document.querySelector('dialog[open]')?.innerText, buttons: [...document.querySelectorAll('dialog[open] button')].map((b) => [b.textContent,b.disabled])})))}`);
  let persisted = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    persisted = await page.evaluate(async (current) => (await window.bookmark.list())[0]?.attachments[0] !== current, current);
    if (persisted) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(persisted, `改字框标注应自动存档：${JSON.stringify(await page.evaluate(async () => ({record: (await window.bookmark.list())[0], value: document.querySelector('.task-edit')?.value, busy: bmImagesBusy, editing: bmEditingId, error: document.querySelector('#board-error')?.textContent})))}`);
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  await page.evaluate(() => {
    const input = document.querySelector('.group[data-group="ChatGPT"] .blank-row textarea');
    input.focus();
    const image = document.createElement("canvas"); image.width = 200; image.height = 120;
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(image.toDataURL("image/png").split(",")[1]), (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], "新图.png", { type: "image/png" }));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.group[data-group="ChatGPT"] .blank-row .bm-rich-input .bm-inline-image', { state: "attached" });
  await page.evaluate(() => document.querySelector('.group[data-group="ChatGPT"] .blank-row .bm-inline-image button').click());
  await page.waitForFunction(() => document.querySelector("dialog[open] img")?.naturalWidth === 200);
  await page.evaluate(() => {
    document.querySelector("dialog[open] .bm-image-annotate").click();
    const canvas = document.querySelector("dialog[open] .bm-annotation-canvas"); canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const event = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height }));
    event("pointerdown", .1, .1); event("pointermove", .7, .6); event("pointerup", .7, .6);
    document.querySelector('dialog[open] .bm-annotation-tools button:last-child').click();
  });
  let inserted = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    inserted = await page.evaluate(async () => (await window.bookmark.list()).some((record) => record.assignee === "ChatGPT" && record.attachments.length === 1));
    if (inserted) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(inserted, "第一格新贴的图片标注后应自动存档");
  assert.deepEqual(errors, []);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false);
  console.log("PASS 图片箭头和文字标注、生成新图、条目及编辑框替换、第一格贴图自动存档、AI 读取新图；测试窗口始终隐藏");
} finally {
  await app?.close();
}
