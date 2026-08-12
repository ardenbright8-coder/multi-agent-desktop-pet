# testkit —— 自测台

**这块管什么**：所有自测。四套要开 Electron 的模式各一个文件，另加 9 份单元测试。

| 文件 | 跑什么 | 命令 |
|---|---|---|
| `smoke.ts` | 命名管道、事件写入、中文索引 | `npm run smoke` |
| `lifecycle.ts` | 显示→收托盘→恢复→后台还活着→待处理面板没丢 | `npm run lifecycle` |
| `single-instance.ts` | 第二次启动不重复开后台 | `npm run single-instance` |
| `screenshot.ts` | 四个面板 + 10 种姿态，每张截图前都有 DOM 断言 | `npm run screenshot` |
| `controls-test.ts` | 17 个固定按钮**真实鼠标／键盘**输入，连跑 3 遍 | `npm run controls` |
| `tests\*.test.ts` | 25 项数据层／协议／管道 | `npm test` |
| `modes.ts` `host.ts` `util.ts` | 命令行开关、跟主入口借东西的口子、等待和断言 | — |

## 对外露出什么

只有 `src\app.ts` 会 import 这儿的东西。**其它任何块都不许调 testkit** —— 边界脚本会拦。

## 依赖谁

所有块都可以调（它的活就是端到端跑）。反过来不行。

## 改之前先知道

- 🚨 **控件测试不许用 DOM 的 `.click()`**，必须走 Electron 的真实鼠标／键盘输入。用 `.click()` 能测过一堆其实点不着的按钮（踩过，所以才改的）。
- 每套测试都写一份 `*-ok.json` 到隔离目录，**外面的脚本靠这个文件判定通过**，不只看退出码。别删那几行。
- 测试一律跑在 `AGENT_PET_HUB_HOME` 指定的隔离目录里，**不碰你正在用的桌宠数据**；`AGENT_PET_SKIP_INTEGRATION_INSTALL=1` 保证不去改四家 Agent 的真配置。
- `smoke` `screenshot` `controls` **故意不抢单实例锁**，所以桌宠开着也能跑；`lifecycle` 和 `single-instance` 要抢锁，靠隔离的 userData 目录跟正在跑的那只错开。
- 状态要靠 `host.ts` 跟主入口借，**别在 testkit 里自己再存一份托盘或服务实例**，退出时会对不上。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
