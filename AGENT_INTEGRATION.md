# 其他 Agent 怎么接进桌宠

## 先说结论

不是任何 Agent 都能凭空实时接入，取决于它向外暴露什么：

1. **有插件 / Hook / Extension**：能实时上报会话、工具、权限、完成和失败，效果最好。
2. **只有结构化日志**：能半实时监听，但权限通常不能可靠交互。
3. **没有事件、只有启动命令**：只能用包装器报告“开始 / 退出”，看不到每个工具。
4. **事件、日志、包装入口都没有**：不能可靠接；解析终端画面不采用，因为容易误报。

当前实接：OpenCode 插件、Claude Code Hooks、Pi Extension、Hermes Plugin、Grok Build Hooks、Codex Hooks。

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

- **OpenCode**：全局 JavaScript 插件，监听会话和工具事件，保留 question／permission 原选项，并通过本机官方 reply 接口把桌宠选择交回 OpenCode。
- **Claude Code**：在 `settings.json` 登记 Hooks；保留 Hook 暴露的结构化选项，但当前不从桌宠回传，明确回 Claude Code 原窗口处理。
- **Pi**：全局 TypeScript Extension 除状态上报外，还注册 `desktop_pet_question` 和 `desktop_pet_permission` 两个顺序工具。Pi 需要询问或给具体操作加一道门时调用它们，桌宠有界等待后把结果交回 Pi。
- **Hermes**：用户 Plugin 监听生命周期和工具 Hook；`clarify` 的结构化内容会进入询问面板，当前仍回 Hermes 原窗口回答。
- **Grok Build**：全局 Hook 文件 `~\.grok\hooks\multi-agent-desktop-pet.json`，上报开始／工具／完成／失败／权限提醒。Grok 没有回传通道，权限和询问在桌宠点了会切回 Grok 窗口处理。
- **Codex**：往 `~\.codex\hooks.json` **追加**桌宠 Hook（不删原来的 Clawd / Emdash 钩子）。权限仍回 Codex 原窗口处理。

## 新 Agent 接入判断顺序

1. 先查官方插件 / Hook / Extension API。
2. 没有 API，再查是否有稳定的 JSONL / SQLite / 结构化日志。
3. 再没有，才做启动包装器。
4. 不解析终端文字和颜色猜状态。

## 书签看板 CLI（Agent 用命令行读写看板 · 2026-09-10）

桌宠运行时，任何能跑 node 命令的 agent 都能用短命令往 **Agent 看板**写任务/结果、领任务。命令**用完即退零常驻**——连的是看板主进程内的本机小服务（127.0.0.1），桌宠没开就报「看板没开」退出，不会挂死。

前提：桌宠仓 `npm run build` 过（CLI 读 dist 编译产物），node 18+。

```powershell
# 干完活报结果：进看板 Claude 分组（实时显示）
node "E:\个人AI资源管理\10_按项目存放（某个项目专用的脚本和资料）\01_手作园（自己从0搓的·应用网页工具）\应用\多Agent桌面宠物（统一通知与权限说明）\app（Electron本体·带git）\scripts\bookmark-cli.mjs" add --to Claude "登录页改完了，等验收"

# 随手记进 💭待定区（不带 --to）
node "...同上路径...\scripts\bookmark-cli.mjs" add "明天问用户要不要加导出功能"

# 领任务：列出交给某个 agent 的条目（大小写不敏感，对齐看板分组）
node "...同上路径...\scripts\bookmark-cli.mjs" list --to Claude

# 机器可读输出（JSON）
node "...同上路径...\scripts\bookmark-cli.mjs" list --to Claude --json
```

- 端口和 token 自动写在 `%APPDATA%\AgentPetHub\bookmark\cli-port.json`（CLI 自动读，不用管）
- 退出码：0 成功；1 看板没开/请求失败；2 参数不对
- 写入的数据与 UI/手机端同一个库：CLI 写的看板里实时出现，右键改派/删除照常

## AI 交接单（CLI 写、看板显眼展示 · 草案 2026-09-10，后续完善）

交接单 = 干完活的 AI 留给接手者的说明条目。写进看板后带 📋 标记和淡黄底，一眼认出；标题两行内，详情点条目展开；也可以直接拖到别的分组上改派（拖到 Claude 就是 Claude 接）。

```powershell
# 写交接单（--to 省略 = 进待定区；详情 --detail 可长可短，不写就只有标题）
node "...同上路径...\scripts\bookmark-cli.mjs" handoff --to Claude "登录页改版完成，交给你验收" --detail "做了：两页签切换+角标+键盘导航。交出来：renderer 三件套改动，测试全绿未提交。下一步：手机端同款待拍板。"

# 接手前：看还有哪些交接单没接
node "...同上路径...\scripts\bookmark-cli.mjs" list --handoff

# 接完活：把这条交接单自己删掉（用户不用手动删）
node "...同上路径...\scripts\bookmark-cli.mjs" remove <条目id>
```

**交接单规则（每个用 CLI 的 AI 必须遵守）**：

1. 接活前先 `list --handoff`，看有没有留给自己的交接单；有就先读详情再干活
2. 干完活（或干到一个段落要交出去）用 `handoff` 写交接单：**标题两行内，大白话写清——做了哪些事、交接哪些任务、往出交哪些东西**；细节写 `--detail` 里，想写多长写多长
3. 接手者把活接完、确认不需要这条交接单了，**必须自己 `remove` 删掉它**，不要留给用户手动清理
4. 交接单可以拖到别的分组（看板上拖到哪组哪组接），接手者以拖后所在的组为准

> 本节规则是草案（2026-09-10 用户拍板首版），用着不顺的地方后续完善。

## 看板领活（用户点「启动 Agent」派给你的活 · 2026-09-24）

用户在看板上点「启动 Agent · 带编程 / 普通」，会给你一句「领看板的活：node "…/bookmark-cli.mjs" next <捆号或条目id> --by <窗口名> [--coding]」。照敲就行，**干活规矩由这条命令自己吐出来**（所有 AI 同一份），不用另读别的文件。要点：

- `next`：领这一捆里下一条没人领的，看板上标「🔄 窗口名 在干」，别的窗口领不走；一次只干这一条
- 干完先别删：把做了啥、怎么验讲给用户，**等他亲口说可以**，再 `done <条目id> --by <窗口名> --ok "他的原话"`（不带原话命令不收）
- 删完再 `next` 领下一条；干不下去 `release <条目id> --by <窗口名>` 放回去
- 看板切到 🌙 睡觉档时（设定18）：领活说明会换成睡觉档那套——干完不等用户，`report <条目id> --by <窗口名> --text "大白话报告"` 挂上报告（条目留着等他早上审），再 `next --to "组名" --by <窗口名>` 接着领这组下一条；快没额度先 `handoff` 写交接单再 `release`
- `--by` 一直用启动那句里给的窗口名，别自己起名
