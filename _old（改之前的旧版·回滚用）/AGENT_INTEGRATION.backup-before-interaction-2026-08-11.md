# 其他 Agent 怎么接进桌宠

## 先说结论

不是任何 Agent 都能凭空实时接入，取决于它向外暴露什么：

1. **有插件 / Hook / Extension**：能实时上报会话、工具、权限、完成和失败，效果最好。
2. **只有结构化日志**：能半实时监听，但权限通常不能可靠交互。
3. **没有事件、只有启动命令**：只能用包装器报告“开始 / 退出”，看不到每个工具。
4. **事件、日志、包装入口都没有**：不能可靠接；解析终端画面不采用，因为容易误报。

当前实接：OpenCode 插件、Claude Code Hooks、Pi Extension、Hermes Plugin。

## 通用接入口

桌宠运行后会安装本机桥接器：

```text
%APPDATA%\AgentPetHub\integrations\agent-pet-hook.mjs
```

任何能执行命令并把 JSON 写到标准输入的 Agent，都可以调用：

```powershell
$payload = @{
  session_id = "会话唯一编号"
  cwd = "E:\项目目录"
  summary = "正在修改登录页"
  tool_name = "edit"
  tool_input = @{ file_path = "src/login.ts" }
} | ConvertTo-Json -Compress

$payload | node "$env:APPDATA\AgentPetHub\integrations\agent-pet-hook.mjs" my-agent state.working
```

桥接器失败时静默放行，不得阻塞 Agent。

## 可上报的事件

- `session.started`：会话开始
- `state.thinking`：正在理解、规划
- `state.working`：正在执行工具
- `permission.requested`：需要用户处理权限
- `permission.resolved`：权限已在原 Agent 处理
- `question.asked`：需要用户回答
- `question.resolved`：回答已处理
- `task.completed`：本轮完成
- `task.failed`：失败或阻塞
- `session.ended`：会话结束

建议至少接四处：会话开始、工具执行前、任务完成、任务失败。支持权限事件的 Agent 再补权限请求与解除。

## 建议字段

```json
{
  "session_id": "稳定的会话编号",
  "cwd": "工作目录",
  "title": "会话标题",
  "summary": "现在正在做什么",
  "reason": "为什么需要用户处理或为什么失败",
  "tool_name": "工具名",
  "tool_input": {
    "file_path": "目标文件",
    "command": "目标命令"
  },
  "request_id": "权限或问题编号"
}
```

桥接器只提取路径、命令、URL、查询词等必要字段，并再次遮盖疑似 token、密码和 API Key。

## 当前四家的接法

- **OpenCode**：全局 JavaScript 插件，监听会话事件和工具执行事件。
- **Claude Code**：在 `settings.json` 登记 Hooks；不改变权限决定，权限仍回 Claude Code 原窗口处理。
- **Pi**：全局 TypeScript Extension，监听 `session_start`、`before_agent_start`、工具执行和 `agent_settled`。Pi 本身没有权限弹窗，所以桌宠只报告状态。
- **Hermes**：用户 Plugin，监听生命周期和工具 Hook；`clarify` 会显示为需要回答，普通权限仍以 Hermes 自己的机制为准。

## 新 Agent 接入判断顺序

1. 先查官方插件 / Hook / Extension API。
2. 没有 API，再查是否有稳定的 JSONL / SQLite / 结构化日志。
3. 再没有，才做启动包装器。
4. 不解析终端文字和颜色猜状态。
