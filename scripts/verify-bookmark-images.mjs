// 真实 Electron/IPC 图文回归；合成剪贴板事件不改系统剪贴板，隐藏窗口不占焦点。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const { _electron } = require("E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright");
const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, ".runtime", "image-tests"), {recursive:true});
const home = mkdtempSync(join(root, ".runtime", "image-tests", "run-"));
let app;
// 样图必须是校验和都对的真 PNG：Electron 解码器很严，坏校验和直接判「无法读取」（原来那张 1×1 的 IDAT 校验和是错的，看着能开其实不合格）
const png = "iVBORw0KGgoAAAANSUhEUgAAAMgAAAB4CAIAAAA48Cq8AAAA7UlEQVR42u3SQREAMAjAsDGZKEEOUvHA8Uwk9BrV+eDalwBjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSzYGHDGAmIcfrtIAAAAAElFTkSuQmCC"; // 200×120：够大，才验得出小图有没有缩到一行字高
async function paste(page, image = png) {
  await page.evaluate((image) => {
    const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "参考.png", {type:"image/png"}));
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", {clipboardData:data, bubbles:true, cancelable:true}));
  }, image);
}
// 等存档落盘：从 Node 这边轮询。别用 waitForFunction 传 async 函数——它拿到的 Promise 本身就算「真」，立刻放行，等于没等。
async function saved(page, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("等存档超时（10 秒）");
}
try {
  app = await _electron.launch({executablePath:join(root,"node_modules/electron/dist/electron.exe"), args:[join(root,"scripts/bookmark-image-test-host.cjs")], env:{...process.env, AGENT_PET_HUB_HOME:home, AGENT_PET_SKIP_INTEGRATION_INSTALL:"1"}});
  const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  page.on("console",m=>console.log("CONSOLE",m.text()));
  const errors = []; page.on("pageerror", (e) => { errors.push(e.message); console.error("PAGE",e.message); });
  await page.locator("#tab-groups").click();
  // 贴图按钮是框里右边一个小图标，不单独占一行（2026-09-24 用户：图片按钮单独占一行，太重，做个小图标往上放）
  const tool = await page.evaluate(() => {
    const row = document.querySelector('.group[data-group="Claude"] .blank-row');
    const box = row.querySelector("textarea").getBoundingClientRect();
    const btn = row.querySelector(".bm-image-tools button"); const b = btn.getBoundingClientRect();
    return { text: btn.textContent.trim(), svg: !!btn.querySelector("svg"), label: btn.getAttribute("aria-label"), inside: b.top >= box.top - 1 && b.bottom <= box.bottom + 1 && b.right <= box.right + 1, rowH: row.getBoundingClientRect().height, boxH: box.height };
  });
  assert.ok(tool.svg && tool.text === "" && tool.label, `贴图按钮应是只有图标的小按钮：${JSON.stringify(tool)}`);
  assert.ok(tool.inside && tool.rowH <= tool.boxH + 4, `贴图按钮应嵌在框里、不另占一行：${JSON.stringify(tool)}`);
  await page.locator('.group[data-group="Claude"] .blank-row textarea').click();
  await page.locator('.group[data-group="Claude"] .blank-row textarea').fill("按钮改这里，下面保留");
  await page.evaluate(() => {const t=document.querySelector('.group[data-group="Claude"] .blank-row textarea'); t.focus();t.setSelectionRange(6,6);});
  await paste(page);
  await page.waitForSelector(".bm-rich-input .bm-inline-image", {timeout:5000}).catch(async(e)=>{console.error(await page.evaluate(()=>({active:document.activeElement.tagName,busy:bmImagesBusy,text:document.querySelector(".insert-row textarea")?.value,error:document.querySelector("#board-error").textContent,html:document.querySelector(".insert-row")?.innerHTML})));throw e;});
  await saved(page, async () => (await window.bookmark.list()).some((r) => r.attachments.length === 1));
  let records = await page.evaluate(() => window.bookmark.list()); assert.equal(records.length,1);
  const id = records[0].id;
  assert.match(records[0].text, /^按钮改这里，[[]图片:image-.*\.png\]下面保留$/);
  await page.evaluate(() => {const input=document.querySelector('.group[data-group="Claude"] .blank-row textarea'); input.focus();input.setSelectionRange(input.value.length,input.value.length);});
  await page.keyboard.type("后面的补充");
  await paste(page);
  await saved(page, async () => (await window.bookmark.list())[0]?.attachments.length === 2);
  await page.locator("#titlebar .title").click();
  await page.waitForSelector(".task-text .bm-inline-image");
  assert.equal(await page.locator(".task-text .bm-inline-image").count(),2);
  // 小图跟一行字差不多高（2026-09-24 用户：小图太大把排版搞乱，像个图标嵌在字里就行）
  const thumb = await page.evaluate(() => {
    const img = document.querySelector(".task-text .bm-inline-image img");
    const line = parseFloat(getComputedStyle(document.querySelector(".task-text")).lineHeight) || 22;
    return { h: img.getBoundingClientRect().height, maxH: getComputedStyle(img).maxHeight, line };
  });
  assert.ok(thumb.h <= thumb.line + 2, `小图应不高于一行字：${JSON.stringify(thumb)}`);
  await page.locator(".task-text .bm-inline-image button").first().click();
  await page.waitForSelector("dialog[open] img");
  // 大图关闭钮：一个 ×，而且不能落在「按住拖窗口」的区域里（落进去真鼠标点了是拖窗口，按钮收不到）
  const closeBtn = await page.evaluate(() => {
    const btn = document.querySelector("dialog[open] .bm-image-close");
    return btn ? { text: btn.textContent, region: getComputedStyle(btn).getPropertyValue("-webkit-app-region"), dialog: getComputedStyle(btn.closest("dialog")).getPropertyValue("-webkit-app-region") } : null;
  });
  assert.ok(closeBtn && closeBtn.text === "×" && closeBtn.region === "no-drag" && closeBtn.dialog === "no-drag", `大图关闭钮：${JSON.stringify(closeBtn)}`);
  assert.equal(await page.locator(".task-edit").count(),0);
  await page.locator("dialog .bm-image-close").click();
  const prompt = await page.evaluate((id) => window.bookmark.copyForAgent(id,null), id);
  assert.ok(prompt.indexOf("图片文件：") < prompt.indexOf("下面保留"));
  assert.ok(prompt.includes("后面的补充")); assert.equal((prompt.match(/图片文件：/g)||[]).length,2);
  assert.ok(!prompt.includes("[图片:"));
  console.log("PASS 粘贴多图、光标位置、图文编辑、大图和复制交接");
  await page.reload(); await page.waitForLoadState("domcontentloaded"); await page.locator("#tab-groups").click();
  await page.waitForSelector(".task-text .bm-inline-image");
  await page.evaluate((id) => window.bookmark.setAssignee(id,"ChatGPT"),id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector('.group[data-group="ChatGPT"] .task-text .bm-inline-image');
  await page.locator('.group[data-group="ChatGPT"] .task-text').click({position:{x:4,y:4}});
  await page.waitForSelector(".bm-rich-input");
  await page.locator(".bm-image-remove").first().click();
  await saved(page, async () => (await window.bookmark.list())[0]?.attachments.length === 1);
  await page.locator("#titlebar .title").click();
  const port = JSON.parse(readFileSync(join(home,"bookmark/cli-port.json"),"utf8"));
  const response = await fetch(`http://127.0.0.1:${port.port}/next`, {method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${port.token}`},body:JSON.stringify({target:id,by:"image-test"})});
  const claim = await response.json(); assert.equal(response.status,200,JSON.stringify(claim));
  assert.equal((claim.prompt.match(/图片文件：/g)||[]).length,1);
  console.log("PASS 重载、改派、移除图片、CLI 领任务图文对应");
  assert.equal(await page.evaluate(async () => {try{await window.bookmark.saveImage(new Uint8Array([1,2,3]));return false;}catch{return true;}}),true);
  assert.equal(await page.evaluate(async () => {try{await window.bookmark.readImage("../bookmarks.json");return false;}catch{return true;}}),true);
  assert.deepEqual(errors,[]);
  const disk = JSON.parse(readFileSync(join(home,"bookmark/bookmarks.json"),"utf8")); assert.equal(disk[0].attachments.length,1);
  assert.equal((await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some((w)=>w.isVisible()))),false);
  console.log("PASS 非图片/越界拒绝、真实磁盘保存、测试窗口保持隐藏");
} finally { await app?.close(); }
