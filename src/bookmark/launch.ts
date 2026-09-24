// 启动 Agent 开窗（2026-09-24 用户拍板做法1）：哪个组开桌面上哪个快捷方式。纯函数，开窗本身在 panel-window。
// 开的就是用户平时双击的那个快捷方式（启动参数、账号、编码都跟着快捷方式走，看板不另拼命令）。
// 🚨 只开窗：启动句进剪贴板，用户自己 Ctrl+V、自己按回车——看板绝不替他发。

export interface AgentShortcut {
  /** 桌面上的快捷方式文件名。 */
  shortcut: string;
  /** true＝每点一次开一个新命令窗口；false＝桌面程序，已开着就只是切到前面，要用户自己新开对话。 */
  freshWindow: boolean;
}

const SHORTCUTS: Record<string, AgentShortcut> = {
  claude: { shortcut: "Claude Code 一.lnk", freshWindow: true },
  chatgpt: { shortcut: "Codex.lnk", freshWindow: false },
  piagent: { shortcut: "Pi 编程智能体.lnk", freshWindow: true },
  hermes: { shortcut: "Hermes.lnk", freshWindow: false },
};

/** 组名 → 桌面快捷方式；用户自己加的组认不出是谁，返回 null（只复制不开窗）。 */
export function agentShortcutFor(group: string): AgentShortcut | null {
  return SHORTCUTS[group.replace(/\s+/g, "").toLowerCase()] ?? null;
}
