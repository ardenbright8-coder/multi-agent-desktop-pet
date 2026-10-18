// 在 Claude Code 的设置文件（settings.json）里接上 vivo 拖图插件和兜底钩子；已经接上的不重复加
// 用法：node 接设置.cjs --settings <settings.json> --mod <插件夹> --hook <钩子脚本.cjs> --backup <备份夹> [--看]
//   --看：只看接没接，打印两行结果，退出码 0=都接了 1=缺了
// 改之前把原文件拷一份到 --backup 夹（名字带时间），写完回读核对
// 插件靠 env 里的 CLAUDE_CODE_PLUGIN_DIRS 加载（Windows 上多个夹用 ; 隔开），只有新开的 Claude Code 窗口才认
const fs = require("fs");
const path = require("path");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === "--看") args.看 = true;
  else args[k.replace(/^--/, "")] = process.argv[++i];
}
for (const k of ["settings", "mod", "hook"]) if (!args[k]) { console.error(`缺 --${k}`); process.exit(2); }

const norm = (p) => path.resolve(p).toLowerCase();
const settings = fs.existsSync(args.settings) ? JSON.parse(fs.readFileSync(args.settings, "utf8")) : {};
const dirs = (settings.env?.CLAUDE_CODE_PLUGIN_DIRS || "").split(";").filter(Boolean);
const hasMod = dirs.some((d) => norm(d) === norm(args.mod));
const hookName = path.basename(args.hook);
const hasHook = (settings.hooks?.UserPromptSubmit || []).some((g) => (g.hooks || []).some((h) => String(h.command || "").includes(hookName)));

if (args.看) {
  console.log(`${hasMod ? "✅" : "❌"} 插件夹在 CLAUDE_CODE_PLUGIN_DIRS 里`);
  console.log(`${hasHook ? "✅" : "❌"} 兜底钩子挂在 UserPromptSubmit 上`);
  process.exit(hasMod && hasHook ? 0 : 1);
}
if (hasMod && hasHook) { console.log("Claude Code 设置早就接好了，没动"); process.exit(0); }

if (fs.existsSync(args.settings)) {
  if (!args.backup) { console.error("缺 --backup，不备份不改"); process.exit(2); }
  fs.mkdirSync(args.backup, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const bak = path.join(args.backup, `settings.json.backup-before-vivo一键装-${stamp}`);
  fs.copyFileSync(args.settings, bak);
  console.log(`原设置已备份：${bak}`);
}
if (!hasMod) {
  settings.env = settings.env || {};
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = [...dirs, args.mod].join(";");
}
if (!hasHook) {
  settings.hooks = settings.hooks || {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
  settings.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: `node "${args.hook}"`, timeout: 10 }] });
}
fs.mkdirSync(path.dirname(args.settings), { recursive: true });
fs.writeFileSync(args.settings, JSON.stringify(settings, null, 2) + "\n");
JSON.parse(fs.readFileSync(args.settings, "utf8"));
console.log(`Claude Code 设置接好了：${hasMod ? "" : "加了插件夹 "}${hasHook ? "" : "加了兜底钩子"}（新开的窗口才生效）`);
