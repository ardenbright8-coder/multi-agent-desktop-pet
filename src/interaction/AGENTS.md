# interaction —— 询问与权限面板

**这块管什么**：Agent 要问你话、要你授权时，面板上那套中文说明和选项怎么来、你的答案怎么交回去。

| 文件 | 管什么 |
|---|---|
| `presenter.ts` | 把一条事件变成面板要显示的东西（标题、口语说明、选项） |
| `permission-explainer.ts` | 权限类事件的风险判断和大白话解释 |
| `broker.ts` | 等你回答这段时间的账：谁在等、超时了怎么退回、答案被谁领走了 |
| `renderer\panel.js` | 面板界面：画选项、收答案、交回 |

## 对外露出什么

```
presentInteraction(event)          → 面板内容
explainPermission(event)           → 风险等级 + 解释
InteractionBroker                  register  claim  complete  cleanup
```

## 依赖谁

**只认 `shared`。** 不许认识 events / channel / pet / integrations。
（是 events 来调它，不是它去调 events —— 方向别弄反。）

## 改之前先知道

- 🚨 **面板文字必须随每次任务变化，不能写死。** 这是敲定过的设计，正本在 `design（现行设计·表述规则）\02_面板表述规则.md`，改之前先读那份。
- **交互等待必须限时。** 回传不支持或超时就退回 Agent 原窗口，不能让人在那儿无限等 —— 桌宠宕机也不许阻断 Agent 干活。
- **答案交回是一次性的**：`claim` 拿到 token 才算领走，重复交回要挡住。测试在 `testkit\tests\interaction-broker.test.ts`。
- 四家里只有 Claude Code 和 Hermes 有真正的提问通道，OpenCode／Pi 的最终点击回传还没在真实会话里验收过（项目门牌里记着）。

- 2026-08-13：Grok 自己的终端权限窗和幼苗是两套。终端点确定幼苗收不到；幼苗点了终端也不走。要对上，得让 Grok 别自己问（`permission_mode = always-approve`），由钩子等幼苗回执。钩子对照 Clawd `permission.js` 的 once/always/reject，自己填对照 `bubble-renderer.js` 的 Other 文本框；写 yes/允许/同意 就是放行。
- 提交时文本框有字就算自己填，不必先点「自己输入」那个圈。旧逻辑只在勾了圈才读文本，人写了 yes 点确认会当成没选。
