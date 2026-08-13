# integrations —— 四家 Agent 怎么接进来

**这块管什么**：把桌宠的插件／Hook 装到 OpenCode、Claude Code、Pi、Hermes 各自的配置里去。

| 在哪 | 是什么 |
|---|---|
| `manager.ts`（本夹） | 启动时确保 OpenCode 插件和通用 Hook 桥装好 |
| 项目根 `integrations\` | **四家的插件源码本体**（`opencode\` `hooks\` `pi\` `hermes\`） |
| 项目根 `scripts\install-*.mjs` | 手动安装脚本，对应 `npm run install:opencode` 等 |

📌 **插件源码为什么不在 src 底下**：它们是**给别家程序加载的独立文件**，不参与本项目编译。放进 `src` 会被 tsc 一起编译，反而坏了分发方式。这是故意的，别"顺手归位"。

## 对外露出什么

```
ensureOpenCodeIntegration()
ensureGenericHookBridge()
ensureGrokHooks()
```

## 依赖谁

**只认 `shared`。** 它写的是别人家的配置文件，不该认识桌宠内部任何一块。

## 改之前先知道

- 🚨 **OpenCode 自动发现只加载 `.js` / `.ts`**，托管插件必须装成 `~\.config\opencode\plugins\multi-agent-desktop-pet.js`。旧的 `.mjs` 在 1.18.14 上**不会被自动加载**（踩过）。
- 开机自启动的快捷方式带 `--skip-integration-install`，**启动时不会重写四家配置**。改这块要想清楚会不会破了这条。
- 接法总纲在项目根 `AGENT_INTEGRATION.md`（新 Agent 怎么判断、可上报哪些事件、字段怎么填），改协议前先读那份。
- 装完要用 `npm run integration:smoke` 验四条线，别只看有没有报错。

- 2026-08-13：Grok 这台机会跑 `~\.claude\settings.json` 里的钩子（名单显示 `global/settings`）。那条桌宠 PreToolUse 必须写 `timeout: 180`，默认 5 秒会被掐，钩子一崩就退出码 1，终端自己弹出英文三选项，幼苗收不到。崩了必须写 `{"decision":"allow"}` 再退出 0，别让终端接手。
