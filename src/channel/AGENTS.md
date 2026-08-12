# channel —— 本机通道

**这块管什么**：桌宠跟外面说话的两条线。一条是各家 Agent 走 Windows 命名管道进来，一条是界面走 Electron IPC 进来。

| 文件 | 管什么 |
|---|---|
| `ipc-server.ts` | 命名管道服务端 + 随机管道名 + discovery 文件 + 鉴权 |
| `ipc-client.ts` | 客户端（自测和 CLI 用） |
| `ipc-handlers.ts` | 界面要快照／搜索／诊断／交答案／发模拟事件 |
| `preload.ts` | 渲染层能看见的那点 API（contextBridge，沙箱开着） |
| `cli-emit.ts` | 命令行往桌宠发一条事件 |

## 对外露出什么

```
LocalIpcServer     start  close
LocalIpcClient     request  publish  search
registerHubIpc(hub, options)
```

## 依赖谁

`shared` ＋ `events`。**不许认识 pet** —— 窗口那几个请求（拖动、拿起、隐藏）不在这儿，在 `pet\window-ipc.ts`。

## 改之前先知道

- 🚫 **不用固定 localhost 端口做主链路**：端口冲突、缓存旧端口、连错服务，全都更难查。现在用的是**每次随机命名的管道**，每次请求重新读 discovery，不缓存旧连接。
- 🚫 **不把长期 WebSocket 当唯一真相**：桌宠重启后应该靠下一次短请求自然恢复。
- 改 `preload.ts` 暴露的 API，**渲染层那几份 js 和 `pet\renderer\global.d.ts` 要一起改**，否则界面调了个不存在的方法，运行时才炸。
- 事件帧有大小上限（`MAX_FRAME_BYTES`），超了直接拒，别指望自动分片。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
