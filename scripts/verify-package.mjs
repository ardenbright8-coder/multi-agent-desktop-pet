import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractFile } from "@electron/asar";

const sourcePackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const releaseRoot = process.env.AGENT_PET_RELEASE_ROOT
  ? resolve(process.env.AGENT_PET_RELEASE_ROOT)
  : resolve(`release-${sourcePackage.version}`, "win-unpacked");
const executable = resolve(releaseRoot, "多Agent桌面宠物.exe");
const asar = resolve(releaseRoot, "resources", "app.asar");
assert.equal(existsSync(executable), true, "Packaged executable is missing");
assert.equal(existsSync(asar), true, "Packaged app.asar is missing");

const packagedPackage = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
// 分块之后各段代码住在各自的功能夹里，这儿挨个夹去验，别再指望全在 app.js 里（机制 26）。
const sessionStore = extractFile(asar, "dist\\events\\session-store.js").toString("utf8");
const main = extractFile(asar, "dist\\app.js").toString("utf8");
const lifecycle = extractFile(asar, "dist\\testkit\\lifecycle.js").toString("utf8");
const petWindow = extractFile(asar, "dist\\pet\\window.js").toString("utf8");
const hook = extractFile(asar, "dist\\integrations\\hooks\\agent-pet-hook.mjs").toString("utf8");
assert.equal(packagedPackage.version, sourcePackage.version, "Packaged version does not match source");
assert.match(sessionStore, /isForeignTerminalState/, "Pending-interaction protection is missing from the package");
assert.match(lifecycle, /lifecycle-ok\.json/, "Lifecycle self-test is missing from the package");
if (process.env.AGENT_PET_RELEASE_ROOT) assert.match(main, /controls-ok\.json/, "Full controls self-test is missing from the package");
assert.match(main, /--skip-integration-install/, "Safe autostart flag is missing from the package");
// 点击穿透：透明区域必须让开鼠标，否则又会挡住底下的程序（v0.1.3 修的那个 bug）
assert.match(petWindow, /setIgnoreMouseEvents/, "Click-through handling is missing from the package");
assert.doesNotMatch(petWindow, /\.setShape\(/, "setShape came back — it does not block clicks on transparent windows");
assert.match(hook, /AGENT_PET_HUB_HOME/, "Isolated integration path support is missing from the package");
process.stdout.write(`PACKAGE_VERIFY_OK version=${packagedPackage.version} exe=${executable}\n`);
