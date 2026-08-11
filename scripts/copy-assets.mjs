import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve("dist", "renderer");
mkdirSync(out, { recursive: true });
cpSync(resolve("src", "renderer"), out, { recursive: true });

const integrationsOut = resolve("dist", "integrations");
mkdirSync(integrationsOut, { recursive: true });
cpSync(resolve("integrations"), integrationsOut, { recursive: true });

const assetsOut = resolve("dist", "assets");
mkdirSync(assetsOut, { recursive: true });
cpSync(resolve("assets"), assetsOut, { recursive: true });
