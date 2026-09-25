// 修「删了又回来」（2026-09-25）：删手机发来的条目记下 dedupeKey，看板重开（新 store 读同一个文件）还记得。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookmarkStore } from "../../bookmark/store";

test("删掉手机发来的条目：记住它，重开看板后同一条还认得是删过的；别的条目不受影响", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bm-removed-")), "bookmarks.json");
  const store = new BookmarkStore(file);
  const phone = store.add({ text: "手机记的", dedupeKey: "key-1" });
  store.add({ text: "电脑记的" });
  assert.equal(store.wasRemoved("key-1"), false);
  assert.ok(store.remove(phone.id));
  assert.equal(store.wasRemoved("key-1"), true);
  const reopened = new BookmarkStore(file);
  assert.equal(reopened.wasRemoved("key-1"), true, "重开看板还记得");
  assert.equal(reopened.wasRemoved("key-2"), false);
  assert.deepEqual(reopened.list().map((r) => r.text), ["电脑记的"]);
});
