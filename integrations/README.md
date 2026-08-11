# Agent 接入状态

- OpenCode：插件保留状态上报，并接入 1.18.14 本机服务的 v2 question/permission reply 接口；只在事件声明支持时显示 `always`。代码链已完成，新 OpenCode 会话的最终点击回传待实测。
- Claude Code：Hook 保留结构化选项，但现有 Hook 合同不能安全回传，面板明确要求回原窗口处理。
- Pi：0.84.1 ExtensionAPI 注册 `desktop_pet_question` 和 `desktop_pet_permission` 两个顺序工具。真实模型已经调用提问工具并让桌宠收到事件，30 秒无回答时也能按时退回；最终点击回传待实测。
- Hermes：Plugin 保留 `clarify` 暴露的结构化选项；现有合同没有准确回传通道，面板明确要求回原窗口处理。

普通状态接入器必须 fail-open。交互等待必须有超时；桌宠不在线时，不能让 Agent 无限等待或改变原本权限策略。
