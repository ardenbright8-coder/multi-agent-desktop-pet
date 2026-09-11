// 📁 项目文件夹单测：名字校验/路径安全纯函数 + 临时目录里的真实 IO（建夹/建md/列表）。
// IO 走 mkdtemp 临时根，AGENT_PET_HUB_HOME 无关（projectsRoot 只在 panel-window 接线用，纯函数测试直接传 root）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProjectFolder,
  createProjectMarkdown,
  listProjects,
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

test("listProjects：越界相对路径抛错、不存在的目录回落空列表", () => {
  const root = tempRoot();
  assert.throws(() => listProjects(root, ".."), /越出项目夹/);
  const empty = listProjects(root, "不存在的夹");
  assert.equal(empty.dirs.length, 0);
  assert.equal(empty.files.length, 0);
});
