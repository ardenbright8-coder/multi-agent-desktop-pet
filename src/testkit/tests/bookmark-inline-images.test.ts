// 图文交接：通过公开拼接入口验证顺序和旧任务兼容。
import assert from "node:assert/strict";
import test from "node:test";
import { composeForAgent } from "../../bookmark/templates";
import { attachmentsRoot } from "../../shared/paths";
import { join } from "node:path";

test("图文交接保留图片在两段说明之间，提供本机可读路径", () => {
  const text = composeForAgent(null, {text: "修改按钮\n[图片:image-123.png]\n保留下面的输入框", url: null, detail: null});
  assert.ok(text.includes(join(attachmentsRoot(), "image-123.png")));
  assert.ok(text.indexOf("修改按钮") < text.indexOf("image-123.png"));
  assert.ok(text.indexOf("image-123.png") < text.indexOf("保留下面的输入框"));
  assert.ok(!text.includes("[图片:"));
});
