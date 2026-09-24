// 复制给 AI 单测：要求模板夹怎么列、复制出去的文字怎么拼（2026-09-24 用户拍板：一行一个复制钮，气泡里选带哪套要求）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeForAgent, listTemplates } from "../../bookmark/templates";

test("listTemplates：一份 md 一项、文件名去掉后缀当名字；空文件、非 md、子夹不算；夹不存在返回空", () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-templates-"));
  writeFileSync(join(dir, "带编程那套.md"), "﻿先读工作流\n", "utf8");
  writeFileSync(join(dir, "找资料.md"), "只查不改", "utf8");
  writeFileSync(join(dir, "空的.md"), "  \n", "utf8");
  writeFileSync(join(dir, "笔记.txt"), "不是 md", "utf8");
  mkdirSync(join(dir, "子夹.md"));
  const list = listTemplates(dir);
  assert.deepEqual(list.map((t) => t.name).sort(), ["带编程那套", "找资料"]);
  assert.equal(list.find((t) => t.name === "带编程那套")?.text, "先读工作流");
  assert.deepEqual(listTemplates(join(dir, "没有这个夹")), []);
});

test("composeForAgent：不带要求＝只有这条；带要求＝要求在前、「这次的事」在后；链接和详情跟着这条走", () => {
  const record = { text: "脑图搜索框看不见", url: null, detail: null };
  assert.equal(composeForAgent(null, record), "脑图搜索框看不见");

  const full = { text: "脑图搜索框看不见", url: "https://example.com", detail: "文本视图下点🔍没反应" };
  assert.equal(composeForAgent(null, full), "脑图搜索框看不见\nhttps://example.com\n文本视图下点🔍没反应");
  assert.equal(
    composeForAgent("先读工作流", full),
    "先读工作流\n\n## 这次的事\n\n脑图搜索框看不见\nhttps://example.com\n文本视图下点🔍没反应",
  );
});
