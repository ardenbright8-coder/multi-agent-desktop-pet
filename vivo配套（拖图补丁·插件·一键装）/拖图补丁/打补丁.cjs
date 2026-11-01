// vivo 办公套件拖图补丁：读原版 app.asar，改两小段，写出一份新的 app.asar（不碰原件）
// 用法：node 打补丁.cjs <原版app.asar> <输出app.asar>
//       node 打补丁.cjs --看 [app.asar]   只看装没装：打印「已装 / 没装 / 装的是旧版」，退出码 0=已装最新 1=没装 2=没找到 3=装的是旧版补丁
//       node 打补丁.cjs --版本 <app.asar>  打印这份程序包的 vivo 版本号（装补丁.ps1 用它找同版本的原版备份）
// 改了什么：
//   1. 手机截图弹窗那个分块（8 月版叫 dist/electron/174.js，7.0.6 版叫 184.js；按图片那行锚点自动找）：
//      弹窗一出来就在后台下载原图；拖图时交出原图文件；电脑上只留最新 10 张；
//      点图＝复制（原来是打开），复制完 0.6 秒就关弹窗（原来 2 秒）
//   2. dist/electron/main.js（主程序）：末尾加一个「拖文件」小帮手，收到弹窗的请求就让 Windows 拖这个文件；
//      弹窗滑进来的动画带上 y：vivo 原版动画只给 x，弹窗算好的右下角位置被冲成 y=0，贴在屏幕最顶上、标题被切
// 改之前先知道：每处改动都要求锚点在原文里正好出现 1 次，对不上就整个停下不写文件（vivo 升级改了代码时会这样）
// 2026-10-22 适配 7.0.6：分块改名、发消息的变量从 I 改成 w（现在按 {ipcRenderer:X}=e(4) 自动认）、
//   拼路径的模块 e(12) 没了（改成直接切字符串，新旧版都能用）
// 2026-10-24 第 2 版补丁（v2）：点图复制、弹窗回右下角。补丁改了就要升记号版本号，不然装过旧版的电脑「看」成已装、不会重装
// 用桌宠自带的 electron.exe 跑时，普通 fs 把 .asar 当文件夹（读不了文件头），要用 original-fs
const fs = process.versions.electron ? require("original-fs") : require("fs");
const crypto = require("crypto");

const MARK = "AGENTPET_VIVO_DRAG_PATCH_v2";
const MARK_ANY = "AGENTPET_VIVO_DRAG_PATCH_v";
const KEEP = 10;
const BLOCK = 4 * 1024 * 1024;

// 不给路径时看这套系统登记的 vivo（InstPath；两套共用 F 盘那份后登记脚本会改它）。reg.exe 吐 GBK，用 PowerShell 读
function vivoAsar() {
  try {
    const dir = require("child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WOW6432Node\\pcsuite' -ErrorAction SilentlyContinue).InstPath"],
      { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim().replace(/\\+$/, "");
    if (dir) return require("path").join(dir, "resources", "app.asar");
  } catch { /* 读不到用默认位置 */ }
  return "C:\\Program Files (x86)\\pcsuite\\resources\\app.asar";
}
// 只认图片那行后半截：前半截的 click 会被本补丁改掉，打过补丁的包也要认得出
const POPUP_ANCHOR = "load:i.imgLoadEnd,error:i.imgErr";
const [src, dst] = process.argv.slice(2);
if (src === "--看") {
  const file = dst || vivoAsar();
  if (!fs.existsSync(file)) { console.log("没找到 vivo 程序包"); process.exit(2); }
  const a = readHeader(file);
  const popup = findPopup(a);
  const both = (m) => !!popup && readEntry(a, popup).includes(m) && readEntry(a, "dist/electron/main.js").includes(m);
  if (both(MARK)) { console.log("已装"); process.exit(0); }
  if (popup && readEntry(a, popup).includes(MARK_ANY)) { console.log("装的是旧版补丁"); process.exit(3); }
  console.log("没装");
  process.exit(1);
}
if (src === "--版本") {
  if (!dst || !fs.existsSync(dst)) { console.log("没找到程序包"); process.exit(2); }
  console.log(JSON.parse(readEntry(readHeader(dst), "package.json").toString("utf8")).version);
  process.exit(0);
}

// 找手机截图弹窗在哪个分块：图片那行锚点只出现在它里面
function findPopup(a) {
  const dir = entry(a.header, "dist/electron");
  const hits = Object.keys(dir.files).filter(n => n.endsWith(".js") && !dir.files[n].unpacked && readEntry(a, "dist/electron/" + n).includes(POPUP_ANCHOR));
  return hits.length === 1 ? "dist/electron/" + hits[0] : null;
}
if (!src || !dst) { console.error("用法：node 打补丁.cjs <原版app.asar> <输出app.asar>"); process.exit(2); }

function readHeader(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const len = head.readUInt32LE(12);
  const json = Buffer.alloc(len);
  fs.readSync(fd, json, 0, len, 16);
  return { fd, header: JSON.parse(json.toString()), base: 8 + head.readUInt32LE(4) };
}

function entry(header, p) {
  let node = header;
  for (const part of p.split("/")) node = node.files[part];
  return node;
}

function readEntry(a, p) {
  const e = entry(a.header, p);
  const b = Buffer.alloc(e.size);
  fs.readSync(a.fd, b, 0, e.size, a.base + Number(e.offset));
  return b.toString();
}

function replaceOnce(s, from, to, what) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`${what}：锚点出现 ${n} 次（要正好 1 次），vivo 代码可能改过，停下`);
  return s.replace(from, () => to);
}

function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) blocks.push(crypto.createHash("sha256").update(buf.subarray(i, i + BLOCK)).digest("hex"));
  if (!blocks.length) blocks.push(crypto.createHash("sha256").update(buf).digest("hex"));
  return { algorithm: "SHA256", hash: crypto.createHash("sha256").update(buf).digest("hex"), blockSize: BLOCK, blocks };
}

// ---------- 弹窗（174.js） ----------
function patchPopup(s) {
  if (s.includes(MARK_ANY)) throw new Error("弹窗分块已经打过补丁了，请拿原版来打");
  // 发消息给主程序的变量名每版可能不同（8 月版 I，7.0.6 版 w）
  const ipc = (s.match(/\{ipcRenderer:([A-Za-z_$][\w$]*)\}=e\(4\)/) || [])[1];
  if (!ipc) throw new Error("弹窗分块里找不到 ipcRenderer，vivo 代码可能改过，停下");
  // e(20) 是读写文件的模块（两版都用它）
  if (!/e\(20\)\.(promises|existsSync|readdirSync)/.test(s)) throw new Error("弹窗分块里认不出读文件模块 e(20)，vivo 代码可能改过，停下");
  // 图片：点一下＝复制（原来是打开，「打开」按钮还在），加拖动事件
  s = replaceOnce(s,
    "on:{click:i.handleBrowse,load:i.imgLoadEnd,error:i.imgErr}",
    "on:{click:function(){return i.agentCopy()},load:i.imgLoadEnd,error:i.imgErr,dragstart:function(t){return i.agentDrag(t)}}",
    "弹窗图片点击和拖动事件");
  // 点图复制的：复制完 0.6 秒就关（按「复制」按钮的照旧 2 秒）
  s = replaceOnce(s,
    "this.isCopying=!1,yield r.sleep(2e3),this.hideNotification()",
    "this.isCopying=!1,yield r.sleep(this.agentQuick?600:2e3),this.agentQuick=!1,this.hideNotification()",
    "复制完关弹窗");
  // 弹窗显示后开始后台下载原图
  s = replaceOnce(s,
    "this.isSetTheWidthTo100=t/e>1.35,this.handleShow(),",
    "this.isSetTheWidthTo100=t/e>1.35,this.handleShow(),this.agentPre(),",
    "弹窗显示后预下载");
  // 打开、复制、保存三个按钮：预下载在路上就等它，别两路同时写一个文件
  for (const op of ["BROWSE", "COPY", "SAVE"]) {
    s = replaceOnce(s,
      `r.downloadImage(this.fileInfo,"sync",_.ImageOperation.${op})`,
      `this.agentDl(this.fileInfo,"sync",_.ImageOperation.${op})`,
      `${op} 按钮下载`);
  }
  const methods =
    `agentPre(){/*${MARK}*/try{const f=this.fileInfo;if(!f||this.isFromPcScreen||this.isAuth||!f.originPath||!f.originDownloadPath)return;` +
    `if(this.agentP&&this.agentP.f===f.originPath)return;const S=_.DownloadStatus.SUCCESS;window._log.info("[agentpet] pre download "+f.originPath);` +
    `const p=r.downloadImage(f,"sync",_.ImageOperation.COPY).then(c=>{window._log.info("[agentpet] pre download result "+c);if(c==S){this.agentOk=f.originPath;this.agentPrune(f.originPath)}return c});` +
    `this.agentP={f:f.originPath,p:p}}catch(z){window._log.info("[agentpet] pre err "+z)}}` +
    `agentCopy(){try{window._log.info("[agentpet] click image = copy");this.agentQuick=!0;this.handleCopy()}catch(z){this.agentQuick=!1;window._log.info("[agentpet] copy err "+z)}}` +
    `agentDl(f,t,op){const a=this.agentP;if(a&&f&&a.f===f.originPath){return a.p.then(c=>c==_.DownloadStatus.SUCCESS?c:r.downloadImage(f,t,op))}return r.downloadImage(f,t,op)}` +
    `agentDrag(t){try{const f=this.fileInfo&&this.fileInfo.originPath;if(!f||this.agentOk!==f||!e(20).existsSync(f)){window._log.info("[agentpet] drag skip, original not ready");return}` +
    `t.preventDefault();${ipc}.send("agentpet-vivo-drag",f);window._log.info("[agentpet] drag file "+f);this.autoClose.cancel(),this.autoClose()}catch(z){window._log.info("[agentpet] drag err "+z)}}` +
    `agentPrune(keepPath){try{const fs=e(20),d=keepPath.slice(0,Math.max(keepPath.lastIndexOf("\\\\"),keepPath.lastIndexOf("/")));` +
    `const L=fs.readdirSync(d).filter(n=>/\\.(jpe?g|png|heic|heif|webp|gif|bmp)$/i.test(n)&&n.toLowerCase()!=="icon.png").map(n=>{const p=d+"\\\\"+n;return{p:p,t:fs.statSync(p).mtimeMs}}).sort((a,b)=>b.t-a.t);` +
    `L.slice(${KEEP}).forEach(x=>{if(x.p!==keepPath){try{fs.unlinkSync(x.p)}catch(z){}}})}catch(z){window._log.info("[agentpet] prune err "+z)}}`;
  s = replaceOnce(s, "imgErr(){", methods + "imgErr(){", "加方法");
  return s;
}

// ---------- 主程序（main.js） ----------
function patchMain(s) {
  if (s.includes(MARK_ANY)) throw new Error("main.js 已经打过补丁了，请拿原版来打");
  if (!s.trimEnd().endsWith("}]);")) throw new Error("main.js 结尾跟预期不一样，停下");
  // 弹窗滑进来的动画带上 y：原版只给 x，动画每一帧 setBounds 不带 y，弹窗被冲到 y=0（屏幕最顶上、标题被切）。
  // vivo 自己的日志：recalcBounds setBounds {"y":1000} → win-animation tick end {"y":0}（2026-10-24 根这边 3440×1440）
  s = replaceOnce(s, "{start:{x:l},end:{x:l-o}}", "{start:{x:l,y:c},end:{x:l-o,y:c}}", "弹窗动画带上 y");
  return s +`\n;(function(){/*${MARK}*/try{const{ipcMain:M,nativeImage:N}=require("electron");` +
    `M.on("agentpet-vivo-drag",(ev,f)=>{try{let ic=N.createFromPath(f);if(!ic.isEmpty())ic=ic.resize({width:96});` +
    `ev.sender.startDrag({file:f,icon:ic});global.__log&&global.__log.info("[agentpet] startDrag "+f)}catch(z){global.__log&&global.__log.info("[agentpet] startDrag err "+z)}})}catch(z){}})();\n`;
}

const a = readHeader(src);
const popupPath = findPopup(a);
if (!popupPath) throw new Error("找不到手机截图弹窗那个分块（图片那行锚点没有或不止一处），vivo 代码可能改过，停下");
console.log(`弹窗分块：${popupPath}`);
const targets = {
  [popupPath]: patchPopup,
  "dist/electron/main.js": patchMain,
};

// 原数据区多长：取所有非 unpacked 文件的 offset+size 最大值
let dataEnd = 0;
(function walk(n) {
  for (const k in n.files) {
    const c = n.files[k];
    if (c.files) walk(c);
    else if (!c.unpacked && c.offset !== undefined) dataEnd = Math.max(dataEnd, Number(c.offset) + c.size);
  }
})(a.header);

const header = JSON.parse(JSON.stringify(a.header));
const appended = [];
let next = dataEnd;
for (const [p, fn] of Object.entries(targets)) {
  const before = readEntry(a, p);
  const after = Buffer.from(fn(before));
  const e = entry(header, p);
  e.size = after.length;
  e.offset = String(next);
  e.integrity = integrity(after);
  next += after.length;
  appended.push(after);
  console.log(`改好 ${p}：${before.length} → ${after.length} 字节`);
}

const json = Buffer.from(JSON.stringify(header));
const padded = Math.ceil(json.length / 4) * 4;
const pre = Buffer.alloc(16 + padded);
pre.writeUInt32LE(4, 0);
pre.writeUInt32LE(8 + padded, 4);
pre.writeUInt32LE(4 + padded, 8);
pre.writeUInt32LE(json.length, 12);
json.copy(pre, 16);

const out = fs.openSync(dst, "w");
fs.writeSync(out, pre);
const chunk = Buffer.alloc(8 * 1024 * 1024);
for (let pos = 0; pos < dataEnd; ) {
  const n = fs.readSync(a.fd, chunk, 0, Math.min(chunk.length, dataEnd - pos), a.base + pos);
  fs.writeSync(out, chunk, 0, n);
  pos += n;
}
for (const b of appended) fs.writeSync(out, b);
fs.closeSync(out);

// ---------- 回读验证 ----------
const v = readHeader(dst);
for (const p of Object.keys(targets)) {
  if (!readEntry(v, p).includes(MARK)) throw new Error(`验证失败：${p} 里没有补丁记号`);
}
let checked = 0;
(function walk(n, o, pre) {
  for (const k in n.files) {
    const c = n.files[k], d = o.files[k], q = pre ? pre + "/" + k : k;
    if (c.files) { walk(c, d, q); continue; }
    if (c.unpacked || targets[q]) continue;
    const x = Buffer.alloc(c.size), y = Buffer.alloc(d.size);
    fs.readSync(v.fd, x, 0, c.size, v.base + Number(c.offset));
    fs.readSync(a.fd, y, 0, d.size, a.base + Number(d.offset));
    if (!x.equals(y)) throw new Error(`验证失败：没改的文件 ${q} 内容变了`);
    checked++;
  }
})(v.header, a.header, "");
console.log(`验证通过：两处补丁都在，其余 ${checked} 个文件跟原版一模一样`);
console.log(`输出：${dst}（${fs.statSync(dst).size} 字节）`);
