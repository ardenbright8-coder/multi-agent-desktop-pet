import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractFile } from "@electron/asar";

const sourcePackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const releaseRoot = resolve(`release-${sourcePackage.version}`, "win-unpacked");
const executable = resolve(releaseRoot, "多Agent桌面宠物.exe");
const asar = resolve(releaseRoot, "resources", "app.asar");
assert.equal(existsSync(executable), true, "Packaged executable is missing");
assert.equal(existsSync(asar), true, "Packaged app.asar is missing");

const packagedPackage = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
const sessionStore = extractFile(asar, "dist\\main\\session-store.js").toString("utf8");
const main = extractFile(asar, "dist\\main\\main.js").toString("utf8");
const hook = extractFile(asar, "dist\\integrations\\hooks\\agent-pet-hook.mjs").toString("utf8");
assert.equal(packagedPackage.version, sourcePackage.version, "Packaged version does not match source");
assert.match(sessionStore, /isForeignTerminalState/, "Pending-interaction protection is missing from the package");
assert.match(main, /lifecycle-ok\.json/, "Lifecycle self-test is missing from the package");
assert.match(main, /--skip-integration-install/, "Safe autostart flag is missing from the package");
assert.match(hook, /AGENT_PET_HUB_HOME/, "Isolated integration path support is missing from the package");
process.stdout.write(`PACKAGE_VERIFY_OK version=${packagedPackage.version} exe=${executable}\n`);
