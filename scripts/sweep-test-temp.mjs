// 测试留下的临时夹，统一在这清（2026-10-16 用户：「为什么有这么多垃圾呢？能不能不要再有这种问题了」）。
// 当时攒了 1.6G：系统临时目录 269 个 bm- 夹、.runtime\test-runs 459 个，从来没人清。
// clean.mjs 每次都调它（npm run build、npm test、看板 Ctrl+R 都走 clean.mjs），一个测试脚本都不用改。
//
// 只清测试专用的，名字对上才删：
//   系统临时目录：bm-xxx-六位乱码、agent-pet-xxx-六位乱码（mkdtemp 起的名）
//   仓库 .runtime：test-runs、annotation-tests、image-tests、sleep-tests 下面每次运行一个的子夹
// 一小时以内的留着：可能有测试正在跑。
// 🚨 新写测试照这个起名（或放进上面几个夹），就会被自动清。

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const KEEP_MS = 60 * 60 * 1000;
const TEMP_NAME = /^(bm|agent-pet)-.+-[A-Za-z0-9]{6}$/;
const RUNTIME_DIRS = ["test-runs", "annotation-tests", "image-tests", "sleep-tests"];

export function sweepTestTemp(repoRoot = resolve(import.meta.dirname, "..")) {
  // npm test 会把 TEMP 换成它自己的小夹，真的系统临时目录从 LOCALAPPDATA 拿
  const systemTemp = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp") : tmpdir();
  const targets = [
    ...childDirs(systemTemp).filter((p) => TEMP_NAME.test(p.name)),
    ...RUNTIME_DIRS.flatMap((d) => childDirs(join(repoRoot, ".runtime", d))),
  ];
  const now = Date.now();
  let removed = 0;
  for (const { path } of targets) {
    try {
      if (now - statSync(path).mtimeMs < KEEP_MS) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      // 被占着、删不动的下回再说，不挡编译
    }
  }
  if (removed) console.log(`🧹 清掉 ${removed} 个测试留下的临时夹（一小时前的）`);
  return removed;
}

function childDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(dir, e.name) }));
  } catch {
    return [];
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) sweepTestTemp();
