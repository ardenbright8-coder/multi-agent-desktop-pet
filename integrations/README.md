# Agent 接入状态

- OpenCode：TypeScript/JavaScript 插件已实现，使用命名管道短请求；安装脚本为 `node scripts/install-opencode.mjs`。
- Claude Code：第一版先走通用 `dist/cli/emit.js` 事件桥；正式 marker-scoped Hook 安装器待真实 payload 验证。
- Pi：第一版先保留 Extension 适配接口；不接管权限。
- Hermes：第一版先保留 Python Plugin 适配接口；clarify 与普通权限回退需要分开验证。

普通状态接入器必须 fail-open。桌宠不在线时，不能让 Agent 卡住或改变原本权限策略。
