import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// 分块之后界面文件跟着功能夹走（pet\renderer、interaction\renderer、events\renderer），
// 所以这里不再写死某一个夹，而是把 src 下所有非 .ts 文件按原样拷进 dist。
copyNonTypeScript(resolve("src"), resolve("dist"));

const integrationsOut = resolve("dist", "integrations");
mkdirSync(integrationsOut, { recursive: true });
cpSync(resolve("integrations"), integrationsOut, { recursive: true });

const assetsOut = resolve("dist", "assets");
mkdirSync(assetsOut, { recursive: true });
cpSync(resolve("assets"), assetsOut, { recursive: true });

function copyNonTypeScript(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      copyNonTypeScript(source, target);
      continue;
    }
    if (entry.name.endsWith(".ts")) continue;
    mkdirSync(to, { recursive: true });
    cpSync(source, target);
  }
}
