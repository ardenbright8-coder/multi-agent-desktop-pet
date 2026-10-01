import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

warnIfLivePetRunning();
rmSync(resolve("dist"), { recursive: true, force: true });

// 桌面图标跑的就是这个 dist/。用户的桌宠开着时清空重建，等于在它脚底下换地板：
// 半路懒加载的文件（小人图、看板窗口）可能读不到，重建完界面和后台还可能一新一旧。
// 不拦（看板里 Ctrl+R 自己也走这里），只提醒重开一次。
function warnIfLivePetRunning() {
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const discovery = join(roaming, "AgentPetHub", "runtime", "ipc.json");
  if (!existsSync(discovery)) return;
  let pid = 0;
  try { pid = Number(JSON.parse(readFileSync(discovery, "utf8")).ownerPid) || 0; } catch { return; }
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; }
  console.warn(`⚠️ 桌宠正开着（进程 ${pid}），它跑的就是 dist/。这次清空重建后，记得重开一次桌宠。`);
}
