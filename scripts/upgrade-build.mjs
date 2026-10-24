// 看板「升级」/ Ctrl+R 用的编译（2026-10-24）：先编到 .runtime\dist-next，编成功才换掉 dist，失败旧的照用。
// 用法：node scripts/upgrade-build.mjs（看板里是拿桌宠自带的 electron.exe 加 ELECTRON_RUN_AS_NODE=1 跑，不靠电脑上碰巧装的 node）
// 退出码 0＝换好了；非 0＝没换，dist 还是原来那份。
// 跟 npm run build 的区别：npm run build 先清空 dist 再编，编一半失败桌宠就没得跑；这份编不过 dist 一个字不动。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { sweepTestTemp } from "./sweep-test-temp.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const runtime = join(root, ".runtime");
const next = join(runtime, "dist-next");

mkdirSync(runtime, { recursive: true });
// 上次换下来没删掉的旧 dist（当时有文件被占着）
for (const name of readdirSync(runtime)) {
  if (name.startsWith("dist-old-")) rmSync(join(runtime, name), { recursive: true, force: true, maxRetries: 2 });
}
rmSync(next, { recursive: true, force: true });
sweepTestTemp(root);

step("编译", [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.json"), "--outDir", next]);
step("拷界面文件", [join(root, "scripts", "copy-assets.mjs"), next]);
if (!existsSync(join(next, "app.js"))) fail("编完没找到 app.js");

// 换：整夹改名最快，旧 dist 挪进 .runtime 等下次删。改名被占着（Windows 上偶尔有文件句柄没放）就退一步：新文件逐个盖上去。
const old = join(runtime, `dist-old-${Date.now()}`);
let swapped = false;
try {
  if (existsSync(dist)) renameSync(dist, old);
  try {
    renameSync(next, dist);
    swapped = true;
  } catch (error) {
    if (existsSync(old) && !existsSync(dist)) renameSync(old, dist);
    throw error;
  }
} catch (error) {
  console.warn(`整夹换不了（${error.code || error.message}），改成逐个盖文件`);
}
if (!swapped) {
  copyTree(next, dist);
  rmSync(next, { recursive: true, force: true });
}
try { rmSync(old, { recursive: true, force: true }); } catch { /* 下次再删 */ }
console.log("升级编译完成，dist 已换新");

function step(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: "utf8", windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) fail(`${label}没过（status=${result.status}${result.error ? `，${result.error.message}` : ""}）`);
}

function fail(message) {
  rmSync(next, { recursive: true, force: true });
  console.error(`${message}；dist 没动，还是旧代码`);
  process.exit(1);
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}
