# events —— 事件中枢与会话状态

**这块管什么**：收事件、定会话状态、落盘、建实时索引、供搜索。桌宠"知道谁在干什么"全靠这块。

| 文件 | 管什么 |
|---|---|
| `hub.ts` | 总闸：收事件 → 存 → 索引 → 广播快照；诊断信息也从这儿出 |
| `session-store.ts` | 会话状态机（空闲/理解/工作/等你/完成/出错）和优先级排序 |
| `event-index.ts` | MiniSearch 实时索引，中文单字＋双字都进词典 |
| `event-journal.ts` | 事件落盘、按上限截断、启动时回放 |
| `simulation.ts` | 模拟事件生成器（托盘「发一条测试通知」走的就是它，**不是测试代码**） |
| `renderer\drawer.js` | 事件抽屉界面：会话列表、查历史、连接诊断 |

## 对外露出什么

```
AgentHub          publish  snapshot  search  diagnostics  cleanup
                  submitInteractionResponse  claimInteractionResponse
                  completeInteractionResponse  updateServerInfo
SessionStore      （只有 hub 和测试用）
makeSimulationEvent
```

## 依赖谁

`shared` ＋ `interaction`（会话状态要调 `presentInteraction` 把事件变成面板内容）。
**这条依赖是单向的：interaction 不许反过来认识 events。**
不许认识 `channel`、`pet`、`testkit`。

## 改之前先知道

- 🚫 **不解析终端画面猜状态**，只信官方事件或明确的日志 fallback（项目门牌「改之前先知道」）。
- **待处理面板不能被顺手清掉**：别家来的完成／失败、以及对不上号的解除事件都不许关掉正在等的面板。这是修过的故障，`session-store.ts` 里 `isForeignTerminalState` 就是干这个的，`verify-package.mjs` 打包时还会验它在不在。
- 状态优先级固定为 **需要处理 > 失败阻塞 > 完成未读 > 正在工作 > 空闲**，别按时间排。
- 中文索引要同时输出单字和双字词，否则只能搜到整句。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
