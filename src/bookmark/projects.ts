// 📁 项目文件夹（2026-09-11 用户拍板）：看板第三页签「📁 项目」背后的真实文件操作。
// 用户原话：鼠标碰到文件夹自动弹目录、单击进去、能建夹建 md、点 md 用系统默认程序打开；
// 存真实文件夹+真实 md（不是程序里的假数据），跟书签库同窝（bookmark\projects\）。
// 设计：纯函数（名字校验/路径安全）跟 IO（列表/建夹/建md）同模块；open 由 panel-window 调 shell（electron 侧），这层不 import electron 保持可测。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { bookmarkProjectsDirectory } from "../shared/paths";

/** 项目条目（列表渲染用）：name=条目名，relPath=相对 projects 根的路径（正斜杠风格给渲染层），isDir=是不是文件夹。 */
export interface ProjectEntry {
  name: string;
  relPath: string;
  isDir: boolean;
  /** 只有项目根那层的夹带：行尾那排小按钮（2026-10-29）。子夹不带。 */
  kit?: KitChip[];
}

/** 项目行尾的一个小按钮：点了打开项目夹里的一份 md 或一个子夹。 */
export interface KitChip {
  /** 项目夹里的名字（`设计思路.md`、`资源包`），也是排序账里记的那个。 */
  name: string;
  /** 按钮上的字：md 去掉后缀。 */
  label: string;
  relPath: string;
  isDir: boolean;
}

export interface ProjectListing {
  dirs: ProjectEntry[];
  files: ProjectEntry[];
  /** 板上的顺序。没排过 = 夹在前、文件在后，各自按名字。排过以后按人拖的顺序，夹和文件可以交错。 */
  ordered: ProjectEntry[];
}

/** 每层目录里的顺序账。点开头，列表不显示它。 */
export const PROJECT_ORDER_FILE = ".排序.json";

/** 每个项目自己那排小按钮的账（2026-10-29 用户：任何一个都能加、能左右换位置）。点开头，列表不显示它。 */
export const PROJECT_KIT_FILE = ".小按钮.json";
/** 没记过账的项目：照新建项目夹自带的三块。 */
export const DEFAULT_KIT = ["设计思路.md", "执行过程.md", "资源包"];

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
  if (!existsSync(abs)) return { dirs: [], files: [], ordered: [] };
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
  // 小按钮只挂项目根那层的夹（以前子夹也挂，指向的文件根本不存在）
  if (!String(relative ?? "").trim()) for (const dir of dirs) dir.kit = readProjectKit(root, dir.relPath);
  const saved = readProjectOrder(abs);
  const ordered = saved.length ? applyProjectOrder([...dirs, ...files], saved) : [...dirs, ...files];
  return { dirs, files, ordered };
}

/** 一个项目那排小按钮：照账里的顺序，账上有、夹里已经没了的跳过。没记过账＝默认三块。 */
export function readProjectKit(root: string, projectRel: string): KitChip[] {
  const abs = resolveProjectPath(root, projectRel);
  const chips: KitChip[] = [];
  for (const name of readKitNames(abs)) {
    const target = join(abs, name);
    if (!existsSync(target)) continue;
    const isDir = statSync(target).isDirectory();
    chips.push({ name, label: isDir ? name : name.replace(/\.md$/i, ""), relPath: toRelPath(root, target), isDir });
  }
  return chips;
}

/** 小按钮的增、减、换位置都走这一个口子，改完写回账、返回新的一排。 */
export function editProjectKit(
  root: string,
  projectRel: string,
  edit:
    | { op: "add"; name: string }
    | { op: "remove"; name: string }
    | { op: "move"; name: string; anchor: string; place: "above" | "below" }
    | { op: "set"; names: string[] },
): KitChip[] {
  const abs = resolveProjectPath(root, projectRel);
  if (!String(projectRel ?? "").trim() || !existsSync(abs)) throw new Error("项目夹不在了");
  let names = readKitNames(abs);
  if (edit.op === "set") {
    // 撤回用（2026-10-29）：整排换回之前那份
    names = [...new Set(edit.names.map((n) => String(n ?? "").trim()).filter((n) => n && !/[\\/]|\.\./.test(n)))];
  } else if (edit.op === "add") {
    const name = sanitizeEntryName(edit.name);
    if (!existsSync(join(abs, name))) throw new Error(`「${name}」不在这个项目夹里`);
    if (!names.includes(name)) names = [...names, name];
  } else if (edit.op === "remove") {
    names = names.filter((n) => n !== edit.name);
  } else {
    names = moveInOrder(names, edit.name, edit.anchor, edit.place);
  }
  writeFileSync(join(abs, PROJECT_KIT_FILE), JSON.stringify(names), "utf8");
  return readProjectKit(root, projectRel);
}

/** 「＋」里挑已有的：项目夹里还没上按钮的 md 和子夹。 */
export function kitCandidates(root: string, projectRel: string): string[] {
  const abs = resolveProjectPath(root, projectRel);
  if (!existsSync(abs)) return [];
  const used = new Set(readKitNames(abs));
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => !d.name.startsWith(".") && !used.has(d.name) && (d.isDirectory() || (d.isFile() && d.name.toLowerCase().endsWith(".md"))))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 「＋」里新建：建一份 md 或一个空夹（不套项目三块），顺手加成按钮。返回新的一排。 */
export function createKitEntry(root: string, projectRel: string, kind: "md" | "dir", rawName: string): KitChip[] {
  const abs = resolveProjectPath(root, projectRel);
  if (!String(projectRel ?? "").trim() || !existsSync(abs)) throw new Error("项目夹不在了");
  let name: string;
  if (kind === "md") {
    name = basename(createProjectMarkdown(root, projectRel, rawName));
  } else {
    name = sanitizeEntryName(rawName);
    const target = join(abs, name);
    if (existsSync(target)) throw new Error(`「${name}」已经存在了`);
    mkdirSync(target);
  }
  return editProjectKit(root, projectRel, { op: "add", name });
}

/** 撤回「＋」新建的那一下（2026-10-29 用户：弄错了 Ctrl+Z 撤回）：按钮拿掉；文件还是刚建时的样子（md 只有标题行、夹是空的）才删，
 *  已经写进东西的留着不删。返回新的一排和删没删。 */
export function discardKitEntry(root: string, projectRel: string, rawName: string): { kit: KitChip[]; deleted: boolean } {
  const abs = resolveProjectPath(root, projectRel);
  const name = sanitizeEntryName(rawName);
  const kit = editProjectKit(root, projectRel, { op: "remove", name });
  const target = join(abs, name);
  if (!existsSync(target)) return { kit, deleted: false };
  if (statSync(target).isDirectory()) {
    if (readdirSync(target).length) return { kit, deleted: false };
    rmdirSync(target);
    return { kit, deleted: true };
  }
  const fresh = `# ${name.replace(/\.md$/i, "")}\n`;
  if (readFileSync(target, "utf8") !== fresh) return { kit, deleted: false };
  unlinkSync(target);
  return { kit, deleted: true };
}

function readKitNames(abs: string): string[] {
  const file = join(abs, PROJECT_KIT_FILE);
  if (!existsSync(file)) return [...DEFAULT_KIT];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [...DEFAULT_KIT];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [...DEFAULT_KIT];
  }
}

/** 按保存的名字顺序排。账上没有的新条目按名字补在最后。 */
export function applyProjectOrder(entries: ProjectEntry[], saved: string[]): ProjectEntry[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const used = new Set<string>();
  const ordered: ProjectEntry[] = [];
  for (const name of saved) {
    const hit = byName.get(name);
    if (!hit || used.has(name)) continue;
    used.add(name);
    ordered.push(hit);
  }
  const rest = entries.filter((entry) => !used.has(entry.name));
  rest.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return ordered.concat(rest);
}

/** 把一个名字挪到另一个名字的上面或下面。纯排列表，不碰磁盘。 */
export function moveInOrder(names: string[], moving: string, anchor: string, place: "above" | "below"): string[] {
  const from = names.indexOf(moving);
  if (from < 0 || moving === anchor) return names.slice();
  const next = names.slice();
  next.splice(from, 1);
  let to = next.indexOf(anchor);
  if (to < 0) return names.slice();
  if (place === "below") to += 1;
  next.splice(to, 0, moving);
  return next;
}

/** 把当前这层里的一条挪到另一条旁边，顺序写进这层的 .排序.json。 */
export function reorderProjects(
  root: string,
  relative: string,
  movingName: string,
  anchorName: string,
  place: "above" | "below",
): ProjectListing {
  const listing = listProjects(root, relative);
  const next = moveInOrder(listing.ordered.map((entry) => entry.name), movingName, anchorName, place);
  const abs = resolveProjectPath(root, relative);
  writeFileSync(join(abs, PROJECT_ORDER_FILE), JSON.stringify(next), "utf8");
  return listProjects(root, relative);
}

function readProjectOrder(abs: string): string[] {
  const file = join(abs, PROJECT_ORDER_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

/** 新建项目夹自带三块：两份稿 + 一个空资源包。资源包本身不再套三块。 */
function seedProjectTemplate(target: string): void {
  writeFileSync(join(target, "设计思路.md"), "# 设计思路\n\n（还没写）\n", "utf8");
  writeFileSync(join(target, "执行过程.md"), "# 执行过程\n\n（还没写）\n", "utf8");
  mkdirSync(join(target, "资源包"));
}

/** 建项目夹：真实 mkdir（父链自动补），重名抛错。建好就带上设计思路、执行过程、资源包。返回新夹的相对路径。 */
export function createProjectFolder(root: string, parentRelative: string, rawName: string): string {
  const name = sanitizeEntryName(rawName);
  const parentAbs = resolveProjectPath(root, parentRelative);
  if (!existsSync(parentAbs)) throw new Error("上级文件夹不存在");
  const target = join(parentAbs, name);
  if (existsSync(target)) throw new Error(`「${name}」已经存在了`);
  mkdirSync(target, { recursive: true });
  seedProjectTemplate(target);
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
