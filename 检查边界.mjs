// =====================================================================
//  检查边界 —— 谁不许调谁，机器说了算
//
//  为什么要这个：分块靠自觉是守不住的。门牌是纸面规矩，AI（和人）改着改着
//  就会顺手从 channel 里直接摸 pet 的内部函数，一次没人发现，块就白分了。
//  这个脚本是机器执行那一道。
//
//  怎么用：改完代码跑一次
//      node 检查边界.mjs
//      node 检查边界.mjs --接口      顺带列出每块对外露出哪些东西（写门牌时照抄）
//  全绿 → 边界还在。报红 → 要么改代码，要么这条依赖确实合理，
//  那就加进下面的「已知例外」，并在对应 AGENTS.md 里写清为什么。
//
//  两套检查：
//   ① 主进程 .ts —— 看 import 谁
//   ② 界面 .js  —— 这几份是普通 script 共享全局作用域，没有 import，
//                   所以按「函数住在哪个文件、谁调了它」来判（跟续枝面板一个思路）
// =====================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "./node_modules/typescript/lib/typescript.js";

const root = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(root, "src");

// ---------- 规矩：每块准依赖谁 ----------
// shared 是底座，谁都不许它反过来依赖任何功能块。
// interaction 只认 shared；events 可以用 interaction（会话状态要生成面板呈现，单向）；
// channel 和 pet 认 events；integrations 谁也不认。
// testkit 和入口 app.ts 可以调所有人 —— 但反过来任何人都不许调 testkit。
const allowed = {
  shared: [],
  interaction: ["shared"],
  events: ["shared", "interaction"],
  channel: ["shared", "events"],
  pet: ["shared", "events"],
  integrations: ["shared"],
  // bookmark（书签台）是 2026-09-09 并入的完全隔离大板块：只认 shared，跟桌宠本体零共享状态。
  // 托盘入口走 app.ts 注入（PetTrayActions.openBookmark），pet 块不 import 它，反向依赖不存在。
  bookmark: ["shared"],
  testkit: ["shared", "events", "interaction", "channel", "pet", "integrations", "bookmark"],
  app: ["shared", "events", "interaction", "channel", "pet", "integrations", "bookmark", "testkit"],
};

// ---------- 每块根上哪些文件是对外入口（别的块只准 import 这些）----------
// 子夹（renderer/、lib/）一律内部。自测块 testkit 可 import 任意根文件，方便单测内部模块。
const publicEntries = {
  shared: ["protocol.ts", "paths.ts", "atomic-file.ts", "log.ts"],
  events: ["hub.ts", "simulation.ts"],
  interaction: ["broker.ts", "presenter.ts", "permission-explainer.ts"],
  channel: ["ipc-server.ts", "ipc-client.ts", "ipc-handlers.ts", "preload.ts", "cli-emit.ts"],
  pet: ["window.ts", "window-ipc.ts", "tray.ts"],
  integrations: ["manager.ts"],
  bookmark: ["panel-window.ts", "store.ts", "preload.ts", "dock.ts"],
  testkit: ["modes.ts", "controls-test.ts", "lifecycle.ts", "screenshot.ts", "single-instance.ts", "smoke.ts", "host.ts"],
};

// ---------- 界面侧：哪个文件是底座、哪个是启动装配 ----------
// shell.js 是调度层（renderSnapshot 得挨个通知各块），boot.js 是启动装配，
// 这两份可以调所有人；其余界面文件之间不许互调。
const rendererFreeCallers = ["pet/renderer/shell.js", "pet/renderer/boot.js"];
const rendererBaseFile = "pet/renderer/shell.js";

// ---------- 已知欠账（拆分时就发现的真耦合，还没治，先记在这别装看不见）----------
// 这不是「允许」，是「欠着」。治的办法写在 pet\AGENTS.md 的「欠账」一节。
// 治好一条就从这儿删一条。别往这儿加新的 —— 新的越界就是该改代码。
// ✅ 2026-08-12 已清零：面板互斥统一收进 shell.js 的 openPanel／restoreInteractionAfterPanelClose／refreshPetPose 调度口，
//    drawer.js／panel.js／pet.js 不再互相点名（抽屉、设置、询问权限、完成弹窗四家只报「我要开了」）。
const debt = [];

const tsFiles = [];
const jsFiles = [];
walk(srcRoot);

const violations = [];
const known = [];

// ===== ① 主进程 .ts：看 import =====
for (const file of tsFiles) {
  const rel = relative(srcRoot, file).split(sep).join("/");
  const from = blockOf(rel);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    const specifier = importSpecifier(statement);
    if (!specifier || !specifier.startsWith(".")) continue;
    const target = relative(srcRoot, resolve(dirname(file), specifier)).split(sep).join("/");
    const to = blockOf(target);
    if (to === from) continue;
    if (isNestedPath(target)) {
      violations.push(`${rel}  第 ${line(source, statement)} 行  import 了  ${target}（${to} 块子夹）　—— 跨块只准走入口，不许进子夹`);
      continue;
    }
    if (!(allowed[from] || []).includes(to)) {
      violations.push(`${rel}  第 ${line(source, statement)} 行  import 了  ${target}（${to} 块）　—— ${from} 不许依赖 ${to}`);
      continue;
    }
    if (from !== "testkit" && !isPublicEntry(to, target)) {
      violations.push(`${rel}  第 ${line(source, statement)} 行  import 了  ${target}　—— ${to} 块入口只有 ${(publicEntries[to] || []).join("、") || "（未登记）"}`);
    }
  }
}

// ===== ② 界面 .js：函数住哪、谁调了它 =====
const fnHome = new Map();
for (const file of jsFiles) {
  const rel = relative(srcRoot, file).split(sep).join("/");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) fnHome.set(statement.name.text, rel);
  }
}
for (const file of jsFiles) {
  const rel = relative(srcRoot, file).split(sep).join("/");
  if (rendererFreeCallers.includes(rel)) continue;
  const from = blockOf(rel);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  visit(source);

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const home = fnHome.get(name);
      if (home && home !== rel && home !== rendererBaseFile && blockOf(home) !== from) {
        if (debt.some((item) => item.file === rel && item.fn === name)) {
          known.push(`${rel}  第 ${line(source, node)} 行  调了  ${name}`);
        } else {
          violations.push(`${rel}  第 ${line(source, node)} 行  调了  ${name}（住在 ${home}）　—— 界面各块之间不许互调`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
}

if (known.length) {
  console.log(`⚠️ 已知欠账 ${known.length} 处（拆分时就在，还没治，不算失败）：`);
  for (const item of known) console.log(`   ${item}`);
  console.log("   治法见 pet\\AGENTS.md 的「欠账」一节\n");
}

if (violations.length) {
  console.log(`🚨 新越界 ${violations.length} 处（这些是要改的）：`);
  for (const item of violations) console.log(`   ${item}`);
  process.exit(1);
}
console.log(`✅ 边界没问题，${tsFiles.length + jsFiles.length} 个文件全过（欠账不算）`);

// ---------- 顺带 report：每块对外露出什么（写门牌时照这个抄）----------
if (process.argv.includes("--接口")) {
  console.log("\n---- 每块被别的块用到的东西 ----");
  const used = new Map();
  for (const file of tsFiles) {
    const rel = relative(srcRoot, file).split(sep).join("/");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      const specifier = importSpecifier(statement);
      if (!specifier || !specifier.startsWith(".")) continue;
      const target = relative(srcRoot, resolve(dirname(file), specifier)).split(sep).join("/");
      if (blockOf(target) === blockOf(rel)) continue;
      const names = statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.map((element) => element.name.text)
        : [];
      if (!used.has(target)) used.set(target, new Set());
      for (const name of names) used.get(target).add(name);
    }
  }
  for (const key of [...used.keys()].sort()) {
    console.log(`\n  ${key}`);
    for (const name of [...used.get(key)].sort()) console.log(`      ${name}`);
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".ts")) tsFiles.push(full);
    else if (entry.endsWith(".js")) jsFiles.push(full);
  }
}

function blockOf(relativePath) {
  const head = relativePath.split("/")[0];
  return head.endsWith(".ts") ? "app" : head;
}

function isNestedPath(relativePath) {
  return relativePath.split("/").length > 2;
}

function isPublicEntry(block, relativePath) {
  const base = relativePath.split("/").pop() || "";
  const fileName = /\.(ts|js)$/.test(base) ? base : `${base}.ts`;
  return (publicEntries[block] || []).includes(fileName);
}

function importSpecifier(statement) {
  if (!ts.isImportDeclaration(statement)) return null;
  return ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
}

function line(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
