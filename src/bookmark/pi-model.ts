// 派活单一键启动挑 Pi 模型（2026-10-16 用户拍板）：挑一个＝替他在 Pi 里按一次 Ctrl+E——改的是 Pi 自己记的
// 「上次用的模型」（settings.json 的 defaultProvider/defaultModel），下次双击图标、下次一键启动默认都是它。
// 开窗照旧走桌面快捷方式，绝不传 --model（Pi 启动器 launcher.ps1 的铁律：一传就顶掉 Pi 自己的记忆）。
// 思考档一律开到最高 max（用户：默认都开 MAX）；模型不支持那么高，Pi 自己降到它能开的最高档，不报错。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../shared/atomic-file";

export const PI_THINKING = "max";

export interface PiModels {
  /** Pi 设置里的 enabledModels（Ctrl+E 能挑的那几个），「供应商/模型」写法。 */
  models: string[];
  /** 现在记着的那个（上次挑的）；没有就 null。 */
  current: string | null;
}

/** Pi 的设置文件。验证脚本用 BOOKMARK_PI_SETTINGS 指到假文件，绝不碰真的。 */
export function piSettingsPath(): string {
  return process.env.BOOKMARK_PI_SETTINGS || join(homedir(), ".pi", "agent", "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
}

export function readPiModels(path = piSettingsPath()): PiModels {
  const s = readSettings(path);
  const models = Array.isArray(s.enabledModels) ? s.enabledModels.map(String).filter(Boolean) : [];
  const current = s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : null;
  return { models, current };
}

/** 记成「上次用的模型」，思考档开到最高。只认 Ctrl+E 名单里的，写错直接报。其余设置原样留着。 */
export function setPiModel(model: string, path = piSettingsPath()): void {
  const s = readSettings(path);
  const { models } = readPiModels(path);
  if (!models.includes(model)) throw new Error(`Pi 没有「${model}」这个模型，能挑的：${models.join("、") || "（Pi 设置里一个都没有）"}`);
  const cut = model.indexOf("/");
  s.defaultProvider = model.slice(0, cut);
  s.defaultModel = model.slice(cut + 1);
  s.defaultThinkingLevel = PI_THINKING;
  // 单个模型自己记的思考档比默认的优先，有就一起改，不然开不到最高
  const per = s.modelThinkingLevels as Record<string, unknown> | undefined;
  if (per && typeof per === "object" && model in per) per[model] = PI_THINKING;
  writeJsonAtomic(path, s);
}
