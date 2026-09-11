// 📁 项目文件夹（2026-09-11 用户拍板）：看板第三页签「📁 项目」背后的真实文件操作。
// 用户原话：鼠标碰到文件夹自动弹目录、单击进去、能建夹建 md、点 md 用系统默认程序打开；
// 存真实文件夹+真实 md（不是程序里的假数据），跟书签库同窝（bookmark\projects\）。
// 设计：纯函数（名字校验/路径安全）跟 IO（列表/建夹/建md）同模块；open 由 panel-window 调 shell（electron 侧），这层不 import electron 保持可测。

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { bookmarkProjectsDirectory } from "../shared/paths";

/** 项目条目（列表渲染用）：name=条目名，relPath=相对 projects 根的路径（正斜杠风格给渲染层），isDir=是不是文件夹。 */
export interface ProjectEntry {
  name: string;
  relPath: string;
  isDir: boolean;
}

export interface ProjectListing {
  dirs: ProjectEntry[];
  files: ProjectEntry[];
}

// Windows 文件名禁用字符 + 保留尾点尾空格；.. 单独拦（防穿越）。
const FORBIDDEN_NAME = /[\\/:*?"<>|]/;

/** 建夹/建md 的名字校验：trim 后非空、禁路径分隔符/Windows非法字符/..。合法返回 trim 后的名字，非法抛错。 */
export function sanitizeEntryName(raw: string): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new Error("名字不能为空");
  if (name === "." || name === ".." || name.includes("..")) throw new Error("名字里不许有 ..");
  if (FORBIDDEN_NAME.test(name)) throw new Error("名字里有系统不允许的字符（\\ / : * ? \" < > |）");
  if (name.endsWith(".") || name.endsWith(" ")) throw new Error("Windows 名字不能以点或空格结尾");
  return name;
}

/** 相对路径安全解析：归一化后必须在 root 内（防 ../ 穿越出去），返回绝对路径；越界抛错。 */
export function resolveProjectPath(root: string, relative: string): string {
  const rel = String(relative ?? "").trim();
  const abs = rel ? resolve(root, rel) : resolve(root);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error("路径越出项目夹了");
  }
  return abs;
}

/** 把绝对路径转回给渲染层的相对路径（正斜杠风格，根 = ""）。前提：abs 在 root 内（先过 resolveProjectPath）。 */
export function toRelPath(root: string, abs: string): string {
  const rootAbs = resolve(root);
  const rest = resolve(abs).slice(rootAbs.length).replace(/\\/g, "/").replace(/^\//, "");
  return rest;
}

/** 列一层：文件夹优先、组内按名排序；只列文件夹和 .md 文件（其他后缀按用户当前需求不进看板）。 */
export function listProjects(root: string, relative: string): ProjectListing {
  const abs = resolveProjectPath(root, relative);
  if (!existsSync(abs)) return { dirs: [], files: [] };
  const dirs: ProjectEntry[] = [];
  const files: ProjectEntry[] = [];
  for (const item of readdirSync(abs, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue; // 隐藏文件不进看板
    const relPath = toRelPath(root, join(abs, item.name));
    if (item.isDirectory()) dirs.push({ name: item.name, relPath, isDir: true });
    else if (item.isFile() && item.name.toLowerCase().endsWith(".md")) {
      files.push({ name: item.name, relPath, isDir: false });
    }
  }
  const byName = (a: ProjectEntry, b: ProjectEntry) => a.name.localeCompare(b.name, "zh-Hans-CN");
  dirs.sort(byName);
  files.sort(byName);
  return { dirs, files };
}

/** 建项目夹：真实 mkdir（父链自动补），重名抛错。返回新夹的相对路径。 */
export function createProjectFolder(root: string, parentRelative: string, rawName: string): string {
  const name = sanitizeEntryName(rawName);
  const parentAbs = resolveProjectPath(root, parentRelative);
  if (!existsSync(parentAbs)) throw new Error("上级文件夹不存在");
  const target = join(parentAbs, name);
  if (existsSync(target)) throw new Error(`「${name}」已经存在了`);
  mkdirSync(target, { recursive: true });
  return toRelPath(root, target);
}

/** 建 .md 文档：自动补 .md 后缀，重名抛错，内容落一行标题（打开就有个开头）。返回新文件的相对路径。 */
export function createProjectMarkdown(root: string, parentRelative: string, rawName: string): string {
  const trimmed = sanitizeEntryName(rawName);
  const name = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
  const parentAbs = resolveProjectPath(root, parentRelative);
  if (!existsSync(parentAbs)) throw new Error("上级文件夹不存在");
  const target = join(parentAbs, name);
  if (existsSync(target)) throw new Error(`「${name}」已经存在了`);
  writeFileSync(target, `# ${trimmed.replace(/\.md$/i, "")}\n`, "utf8");
  return toRelPath(root, target);
}

/** 项目根（数据窝 bookmark\projects\，真实文件夹真实 md 都落这）。 */
export function projectsRoot(): string {
  return bookmarkProjectsDirectory();
}

/** 确保根存在（首次进「📁 项目」页/首次建夹时调，避免每次列目录都 mkdir）。 */
export function ensureProjectsRoot(): void {
  const root = projectsRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}
