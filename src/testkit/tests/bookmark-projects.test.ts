// 📁 项目文件夹单测：名字校验/路径安全纯函数 + 临时目录里的真实 IO（建夹/建md/列表）。
// IO 走 mkdtemp 临时根，AGENT_PET_HUB_HOME 无关（projectsRoot 只在 panel-window 接线用，纯函数测试直接传 root）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createKitEntry,
  createProjectFolder,
  createProjectMarkdown,
  discardKitEntry,
  editProjectKit,
  kitCandidates,
  listProjects,
  moveInOrder,
  reorderProjects,
  resolveProjectPath,
  sanitizeEntryName,
} from "../../bookmark/projects";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bm-projects-test-"));
}

test("sanitizeEntryName：合法名字保留，非法全拦", () => {
  assert.equal(sanitizeEntryName("  毕业旅行计划  "), "毕业旅行计划");
  assert.throws(() => sanitizeEntryName(""), /名字不能为空/);
  assert.throws(() => sanitizeEntryName("   "), /名字不能为空/);
  assert.throws(() => sanitizeEntryName(".."), /不许有/);
  assert.throws(() => sanitizeEntryName("a/b"), /不允许的字符/);
  assert.throws(() => sanitizeEntryName("a\\b"), /不允许的字符/);
  assert.throws(() => sanitizeEntryName("计划:"), /不允许的字符/);
  assert.throws(() => sanitizeEntryName("结尾点."), /点或空格结尾/);
});

test("resolveProjectPath：root 内放行，../ 穿越拒绝", () => {
  const root = tempRoot();
  assert.equal(resolveProjectPath(root, ""), root);
  assert.equal(resolveProjectPath(root, "子夹"), join(root, "子夹"));
  assert.equal(resolveProjectPath(root, "a/b"), join(root, "a", "b"));
  assert.throws(() => resolveProjectPath(root, ".."), /越出项目夹/);
  assert.throws(() => resolveProjectPath(root, "a/../../x"), /越出项目夹/);
  assert.throws(() => resolveProjectPath(root, "C:/Windows"), /越出项目夹/);
});

test("reorderProjects：把第 3 个插到第 1 个前面，刷新还是这个顺序", () => {
  const root = tempRoot();
  createProjectFolder(root, "", "甲");
  createProjectFolder(root, "", "乙");
  createProjectMarkdown(root, "", "丙");
  assert.deepEqual(moveInOrder(["甲", "乙", "丙.md"], "丙.md", "乙", "above"), ["甲", "丙.md", "乙"]);
  const listing = reorderProjects(root, "", "丙.md", "甲", "above");
  assert.deepEqual(listing.ordered.map((entry) => entry.name), ["丙.md", "甲", "乙"]);
  assert.deepEqual(listProjects(root, "").ordered.map((entry) => entry.name), ["丙.md", "甲", "乙"]);
});

test("createProjectFolder：建好就带两份稿和一个空资源包", () => {
  const root = tempRoot();
  createProjectFolder(root, "", "毕业旅行");
  const listing = listProjects(root, "毕业旅行");
  assert.deepEqual(listing.dirs.map((dir) => dir.name), ["资源包"]);
  assert.deepEqual(
    listing.files.map((file) => file.name).sort(),
    ["执行过程.md", "设计思路.md"].sort(),
  );
  const pack = listProjects(root, "毕业旅行/资源包");
  assert.equal(pack.dirs.length, 0);
  assert.equal(pack.files.length, 0);
});

test("createProjectFolder：真实建夹、重名抛错", () => {
  const root = tempRoot();
  const rel = createProjectFolder(root, "", "毕业旅行");
  assert.equal(rel, "毕业旅行");
  assert.ok(existsSync(join(root, "毕业旅行")));
  assert.throws(() => createProjectFolder(root, "", "毕业旅行"), /已经存在/);
  // 嵌套：先进一级再建。
  createProjectFolder(root, "毕业旅行", "路线图");
  assert.ok(existsSync(join(root, "毕业旅行", "路线图")));
});

test("createProjectMarkdown：自动补 .md、落标题行、重名抛错", () => {
  const root = tempRoot();
  const rel = createProjectMarkdown(root, "", "执行方案");
  assert.equal(rel, "执行方案.md");
  assert.ok(readFileSync(join(root, "执行方案.md"), "utf8").startsWith("# 执行方案"));
  // 已带 .md 后缀不重复补。
  const rel2 = createProjectMarkdown(root, "", "路线图.md");
  assert.equal(rel2, "路线图.md");
  assert.throws(() => createProjectMarkdown(root, "", "执行方案"), /已经存在/);
});

test("listProjects：文件夹优先、只列 md、隐藏文件不进看板", () => {
  const root = tempRoot();
  mkdirSync(join(root, "乙项目"));
  mkdirSync(join(root, "甲项目"));
  writeFileSync(join(root, "执行方案.md"), "# t", "utf8");
  writeFileSync(join(root, "草图.png"), "png", "utf8");
  writeFileSync(join(root, ".hidden"), "x", "utf8");
  const listing = listProjects(root, "");
  assert.deepEqual(listing.dirs.map((d) => d.name), ["甲项目", "乙项目"]); // 中文名排序
  assert.deepEqual(listing.files.map((f) => f.name), ["执行方案.md"]); // png 和隐藏文件不进
  assert.ok(listing.dirs[0].isDir);
  // 进子夹列。
  const sub = listProjects(root, "甲项目");
  assert.equal(sub.dirs.length, 0);
  assert.equal(sub.files.length, 0);
});

test("项目小按钮：没记过账＝默认三块；只有项目根那层的夹带，子夹不带", () => {
  const root = tempRoot();
  createProjectFolder(root, "", "中医");
  const top = listProjects(root, "").dirs[0];
  assert.deepEqual(top.kit?.map((c) => c.label), ["设计思路", "执行过程", "资源包"]);
  assert.equal(top.kit?.[2].isDir, true);
  assert.equal(top.kit?.[0].relPath, "中医/设计思路.md");
  const inner = listProjects(root, "中医").dirs[0];
  assert.equal(inner.name, "资源包");
  assert.equal(inner.kit, undefined, "子夹不挂小按钮");
});

test("项目小按钮：挑已有的加上、新建 md 和夹顺手加上、左右换位置、拿掉不删文件", () => {
  const root = tempRoot();
  createProjectFolder(root, "", "中医");
  writeFileSync(join(root, "中医", "药方.md"), "# 药方", "utf8");
  assert.deepEqual(kitCandidates(root, "中医"), ["药方.md"]);
  editProjectKit(root, "中医", { op: "add", name: "药方.md" });
  assert.deepEqual(kitCandidates(root, "中医"), []);
  createKitEntry(root, "中医", "md", "笔记");
  const kit = createKitEntry(root, "中医", "dir", "图片");
  assert.deepEqual(kit.map((c) => c.name), ["设计思路.md", "执行过程.md", "资源包", "药方.md", "笔记.md", "图片"]);
  assert.ok(existsSync(join(root, "中医", "图片")) && !existsSync(join(root, "中医", "图片", "设计思路.md")), "新建的夹是空夹，不套项目三块");
  // 把执行过程挪到设计思路前面
  const moved = editProjectKit(root, "中医", { op: "move", name: "执行过程.md", anchor: "设计思路.md", place: "above" });
  assert.deepEqual(moved.slice(0, 2).map((c) => c.label), ["执行过程", "设计思路"]);
  const removed = editProjectKit(root, "中医", { op: "remove", name: "药方.md" });
  assert.equal(removed.some((c) => c.name === "药方.md"), false);
  assert.ok(existsSync(join(root, "中医", "药方.md")), "拿掉只是不显示");
  assert.deepEqual(listProjects(root, "").dirs[0].kit?.map((c) => c.label), ["执行过程", "设计思路", "资源包", "笔记", "图片"], "刷新还是这个顺序");
  assert.throws(() => editProjectKit(root, "中医", { op: "add", name: "没这个.md" }), /不在这个项目夹里/);
});

test("项目小按钮撤回：set 整排换回去；discard 撤新建的——没写东西才删文件，写过的留着", () => {
  const root = tempRoot();
  createProjectFolder(root, "", "中医");
  createKitEntry(root, "中医", "md", "笔记");
  createKitEntry(root, "中医", "dir", "图片");
  createKitEntry(root, "中医", "md", "写过的");
  writeFileSync(join(root, "中医", "写过的.md"), "# 写过的\n正文\n", "utf8");
  const a = discardKitEntry(root, "中医", "笔记.md");
  assert.equal(a.deleted, true);
  assert.ok(!existsSync(join(root, "中医", "笔记.md")));
  assert.equal(discardKitEntry(root, "中医", "图片").deleted, true, "空夹删掉");
  const c = discardKitEntry(root, "中医", "写过的.md");
  assert.equal(c.deleted, false);
  assert.ok(existsSync(join(root, "中医", "写过的.md")), "写过东西的不删");
  assert.deepEqual(c.kit.map((x) => x.label), ["设计思路", "执行过程", "资源包"]);
  const back = editProjectKit(root, "中医", { op: "set", names: ["资源包", "设计思路.md", "../越界", "执行过程.md"] });
  assert.deepEqual(back.map((x) => x.name), ["资源包", "设计思路.md", "执行过程.md"], "越界的名字不收");
});

test("listProjects：越界相对路径抛错、不存在的目录回落空列表", () => {
  const root = tempRoot();
  assert.throws(() => listProjects(root, ".."), /越出项目夹/);
  const empty = listProjects(root, "不存在的夹");
  assert.equal(empty.dirs.length, 0);
  assert.equal(empty.files.length, 0);
});
