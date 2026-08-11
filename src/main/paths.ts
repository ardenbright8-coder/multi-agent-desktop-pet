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
