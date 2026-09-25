// 图文位置协议：正文里的图片标记随文字一起存、移动和交接，不保存临时文件路径。
// 图片标注（设定16第三版）：标注不烧进原图，单独存 `<图>.marks.json`（编号、位置、说明）＋ `<图>.marked.png`（带编号的那张给 AI 看）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentsRoot } from "../shared/paths";

const IMAGE_MARKER = /\[图片:(image-[a-zA-Z0-9-]+\.png)\]/g;
/** 只有看板自己存的图（image-uuid.png）才能挂标注，挡住任何路径。 */
export const MARKABLE_IMAGE = /^image-[a-zA-Z0-9-]+\.png$/;
export const MAX_MARKS = 60;
export const MAX_MARK_NOTE = 500;

/** 一个标注：位置一律是占图片宽高的比例（0～1，左上角是 0,0）。编号＝在数组里的顺序＋1，不单独存。 */
export interface ImageMark {
  kind: "pin" | "box" | "arrow";
  x: number;
  y: number;
  endX: number;
  endY: number;
  note: string;
}

export function marksFileName(name: string): string {
  return `${name}.marks.json`;
}

export function markedFileName(name: string): string {
  return `${name}.marked.png`;
}

const unit = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

/** 清洗外来标注（渲染层传来的、磁盘读的）：认不出的条丢掉，坐标夹到 0～1，说明截长。 */
export function sanitizeMarks(raw: unknown): ImageMark[] {
  if (!Array.isArray(raw)) return [];
  const marks: ImageMark[] = [];
  for (const item of raw.slice(0, MAX_MARKS)) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (value.kind !== "pin" && value.kind !== "box" && value.kind !== "arrow") continue;
    const x = unit(value.x), y = unit(value.y);
    if (x === null || y === null) continue;
    const endX = unit(value.endX) ?? x, endY = unit(value.endY) ?? y;
    const note = typeof value.note === "string" ? value.note.slice(0, MAX_MARK_NOTE) : "";
    marks.push({ kind: value.kind, x, y, endX, endY, note });
  }
  return marks;
}

export function parseMarks(text: string): ImageMark[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return sanitizeMarks((parsed as { marks?: unknown } | null)?.marks);
  } catch {
    return [];
  }
}

const NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function markNumber(index: number): string {
  return NUMBERS[index] ?? `(${index + 1})`;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const at = (x: number, y: number): string => `（从左 ${pct(x)}、从上 ${pct(y)}）`;

/** 给 AI 的标注清单：一个编号一行，写清是什么、在哪、用户说了什么。 */
export function describeMarks(marks: ImageMark[]): string[] {
  return marks.map((mark, index) => {
    const where = mark.kind === "box"
      ? `框，${at(Math.min(mark.x, mark.endX), Math.min(mark.y, mark.endY))}到${at(Math.max(mark.x, mark.endX), Math.max(mark.y, mark.endY))}`
      : mark.kind === "arrow"
        ? `箭头，从${at(mark.x, mark.y)}指到${at(mark.endX, mark.endY)}`
        : `点，在${at(mark.x, mark.y)}`;
    const note = mark.note.trim() ? mark.note.trim() : "（没写说明，看图上这个位置）";
    return `${markNumber(index)} ${where}：${note}`;
  });
}

export interface ImageMarksLookup {
  marks: ImageMark[];
  marked: boolean;
}

/** 读磁盘上某张图的标注。没有、坏档都当没标。 */
export function readImageMarks(name: string): ImageMarksLookup {
  if (!MARKABLE_IMAGE.test(name)) return { marks: [], marked: false };
  try {
    const path = join(attachmentsRoot(), marksFileName(name));
    const marks = existsSync(path) ? parseMarks(readFileSync(path, "utf8")) : [];
    return { marks, marked: marks.length > 0 && existsSync(join(attachmentsRoot(), markedFileName(name))) };
  } catch {
    return { marks: [], marked: false };
  }
}

export function inlineImageNames(text: string): string[] {
  return [...new Set([...text.matchAll(IMAGE_MARKER)].map((m) => m[1]))];
}

/** 交给 AI：图片标记换成本机路径；标过的图给带编号的那张＋原图＋编号清单，AI 不用自己去认红线。 */
export function imagesForAgent(text: string, lookup: (name: string) => ImageMarksLookup = readImageMarks): string {
  let index = 0;
  return text.replace(IMAGE_MARKER, (_match, name: string) => {
    index += 1;
    const { marks, marked } = lookup(name);
    if (!marks.length) {
      return `\n[图片 ${index}，对应此处上下文；请用读图工具打开，无法读取时明确告知]\n图片文件：${join(attachmentsRoot(), name)}\n`;
    }
    const lines = [
      `[图片 ${index}，对应此处上下文；用户在图上标了 ${marks.length} 处，请用读图工具打开，无法读取时明确告知]`,
      marked ? `图片文件（标了编号的）：${join(attachmentsRoot(), markedFileName(name))}` : null,
      `${marked ? "原图" : "图片文件"}：${join(attachmentsRoot(), name)}`,
      "图上标注（位置按图片宽高的百分比算，左上角是 0%）：",
      ...describeMarks(marks),
    ].filter((line): line is string => line !== null);
    return `\n${lines.join("\n")}\n`;
  });
}

export function reconcileImages(previous: string[], oldText: string, nextText: string): string[] {
  const oldInline = new Set(inlineImageNames(oldText));
  return [...new Set([...previous.filter((name) => !oldInline.has(name)), ...inlineImageNames(nextText)])];
}
