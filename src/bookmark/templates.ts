// 复制给 AI 的「要求模板」（2026-09-24 用户拍板）：条目行尾复制钮 → 气泡选带哪套要求 → 拼好进剪贴板，用户自己粘、自己发。
// 模板夹 = <appDataRoot>\bookmark\要求模板\，一份 md = 气泡里一项，文件名（去后缀）就是显示名；用户改文件就改了要求，不用动代码。
// 纯函数 + 只读 IO，剪贴板写入在 panel-window。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { imagesForAgent, inlineImageNames } from "./inline-images";
import { attachmentsRoot } from "../shared/paths";

export interface RequirementTemplate {
  name: string;
  text: string;
}

/** 列出模板夹里的 md（空文件跳过、BOM 去掉）；夹不存在就是没有模板，气泡只剩「只复制这条」。 */
export function listTemplates(dir: string): RequirementTemplate[] {
  if (!existsSync(dir)) return [];
  const templates: RequirementTemplate[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
    const text = readFileSync(join(dir, entry.name), "utf8").replace(/^﻿/, "").trim();
    if (text) templates.push({ name: basename(entry.name, extname(entry.name)), text });
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 拼出复制出去的文字：不带要求＝只有这条；带要求＝要求在前、「这次的事」在后。 */
export function composeForAgent(
  template: string | null,
  record: { text: string; url: string | null; detail: string | null; attachments?: string[] },
): string {
  const used = new Set(inlineImageNames(record.text));
  const extras = (record.attachments ?? []).filter((name) => !used.has(name)).map((name) => `图片文件（本条附件，请用读图工具打开）：${join(attachmentsRoot(), basename(name))}`);
  const task = [imagesForAgent(record.text), record.url, record.detail, ...extras].filter((part) => part && part.trim()).join("\n");
  return template ? `${template}\n\n## 这次的事\n\n${task}` : task;
}
