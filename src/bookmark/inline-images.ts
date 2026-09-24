// 图文位置协议：正文里的图片标记随文字一起存、移动和交接，不保存临时文件路径。
import { join } from "node:path";
import { attachmentsRoot } from "../shared/paths";

export function inlineImageNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\[图片:(image-[a-zA-Z0-9-]+\.png)\]/g)].map((m) => m[1]))];
}

export function imagesForAgent(text: string): string {
  let index = 0;
  return text.replace(/\[图片:(image-[a-zA-Z0-9-]+\.png)\]/g, (_match, name: string) => {
    index += 1;
    return `\n[图片 ${index}，对应此处上下文；请用读图工具打开，无法读取时明确告知]\n图片文件：${join(attachmentsRoot(), name)}\n`;
  });
}

export function reconcileImages(previous: string[], oldText: string, nextText: string): string[] {
  const oldInline = new Set(inlineImageNames(oldText));
  return [...new Set([...previous.filter((name) => !oldInline.has(name)), ...inlineImageNames(nextText)])];
}
