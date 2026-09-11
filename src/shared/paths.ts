import { homedir } from "node:os";
import { join } from "node:path";

export function appDataRoot(): string {
  if (process.env.AGENT_PET_HUB_HOME) return process.env.AGENT_PET_HUB_HOME;
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(roaming, "AgentPetHub");
}

export function runtimeDirectory(): string {
  return join(appDataRoot(), "runtime");
}

export function discoveryPath(): string {
  return join(runtimeDirectory(), "ipc.json");
}

export function dataDirectory(): string {
  return join(appDataRoot(), "data");
}

export function eventJournalPath(): string {
  return join(dataDirectory(), "events.ndjson");
}

export function preferencesPath(): string {
  return join(dataDirectory(), "preferences.json");
}

// 书签台（书签板块）自己的数据夹 —— 刻意独立于 data\，跟桌宠数据分家（2026-09-09 并入拍板）。
export function bookmarkDataDirectory(): string {
  return join(appDataRoot(), "bookmark");
}

export function bookmarksDataPath(): string {
  return join(bookmarkDataDirectory(), "bookmarks.json");
}

// 收信模块的邮局配置（server/账号/主题）——含密码，放 appData 不进 git（密钥不进仓库铁律）。
export function bookmarkNtfyConfigPath(): string {
  return join(bookmarkDataDirectory(), "ntfy.json");
}

// CLI 接入服务的端口发现文件（{port, token}）——本机回环，桌宠没运行时 CLI 读不到就报错退出。
export function bookmarkCliPortPath(): string {
  return join(bookmarkDataDirectory(), "cli-port.json");
}

// 看板外观设置（透明度等，结构 {opacity:0.6} 预留以后加项）——appData 不进 git。
export function bookmarkAppearancePath(): string {
  return join(bookmarkDataDirectory(), "appearance.json");
}

// 📁 项目文件夹（2026-09-11 拍板：真实文件夹+真实 md 存这，跟书签库同窝不撒外面）。
export function bookmarkProjectsDirectory(): string {
  return join(bookmarkDataDirectory(), "projects");
}
