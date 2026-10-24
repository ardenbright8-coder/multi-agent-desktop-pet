import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// 🚨 不用 fs.cpSync：Node 22.23（根这边唯一的 Node，Hermes 自带）的 cpSync 碰到中文路径会崩（0xC0000409）
// 或删不掉旧文件，看板 Ctrl+R 就「换新失败」（2026-10-24）。一律走下面的 copyTree / copyNonTypeScript。

// 分块之后界面文件跟着功能夹走（pet\renderer、interaction\renderer、events\renderer），
// 所以这里不再写死某一个夹，而是把 src 下所有非 .ts 文件按原样拷进 dist。
copyNonTypeScript(resolve("src"), resolve("dist"));

copyTree(resolve("integrations"), resolve("dist", "integrations"));

// 看板内置模型整理捆的规矩（organizer.ts 运行时读）：打包只带 dist，所以拷一份进去。
const organizerRules = "skills（看板内置模型用·整理捆的规矩）";
copyTree(resolve(organizerRules), resolve("dist", organizerRules));

copyTree(resolve("assets"), resolve("dist", "assets"));

function copyNonTypeScript(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      // 下划线开头的夹是旧版备份和没处理完的素材（_old、_素材暂存…），只留在源码里，不进 dist 和安装包
      if (entry.name.startsWith("_")) continue;
      copyNonTypeScript(source, target);
      continue;
    }
    if (entry.name.endsWith(".ts")) continue;
    mkdirSync(to, { recursive: true });
    copyFileSync(source, target);
  }
}

/** 整个夹原样拷过去（同 cpSync recursive）。 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}
