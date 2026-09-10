# bookmark —— 书签台（完全隔离的大板块）

**这块管什么**：随手记 / 网址收藏 / 「交给谁」标记的独立板块。2026-09-09 用户拍板并入桌宠当常驻壳——**一个壳两个项目**：代码一个区、数据一个库、与桌宠本体零共享状态，后期想拆整块搬走。

| 文件 | 管什么 |
|---|---|
| `store.ts` | 本地库：增删查、「交给谁」标记、dedupeKey 去重（手机离线重发防重复入库）；JSON 原子写 |
| `panel-window.ts` | 面板窗口（Win11 毛玻璃）、全局热键 Alt+S、本块专属 IPC（bookmark:*） |
| `preload.ts` | 本块渲染层专属桥（`window.bookmark`），跟 `channel\preload` 互不相干 |
| `renderer\` | 界面三件套（index.html / bookmark.js / styles.css），独立窗口自含，**不经 shell.js 调度** |

## 对外露出什么

```
initBookmarkPanel  toggleBookmarkPanel  closeBookmarkPanel  BOOKMARK_HOTKEY
BookmarkStore（testkit 单测用）
```

## 依赖谁

**只认 shared**（路径、原子写、日志）。桌宠的 events / channel / pet 一概不认识。
托盘入口是 app.ts 把 `toggleBookmarkPanel` 注进 `PetTrayActions` 的——**本块不许 import pet，pet 也不许 import 本块**。

## 改之前先知道

- 🚨 **隔离铁律：本块出任何故障（断网、崩、超时）都不许连坐桌宠本体。** 收信/网络类逻辑（下一步的 ntfy inbox）必须独立成文件、自带 try/catch 和静默重试。
- 🚨 **数据独立**：`<appDataRoot>\bookmark\bookmarks.json`（`shared\paths.ts` 的 `bookmarkDataDirectory`）。绝不写进桌宠的事件日记/索引，反之一致。坏档挪 `.corrupt-<时间戳>` 存证后空库重来（照 events\event-journal 的先例）。
- 🚨 **置顶层级用 floating，别用 screen-saver** ——那是桌宠窗口的层级（还带 3 秒重申定时器），两个窗口抢层级会打架。
- 热键 **Alt+S** 在 testMode 不注册（app.ts 传 `hotkey: !testMode`），**别把守卫拆了**——自测会跟真机抢全局热键。
- `backgroundMaterial: "acrylic"` 只有 Win11 有效，构造时 try/catch 回落无材质版本；窗口背景色 `#00000000` + CSS 半透明底，两层一起兜。
- 渲染层保持 sandbox 默认隔离，别图省事开 nodeIntegration。
- 面板里的链接一律走 `setWindowOpenHandler` → `shell.openExternal`，别让网页在面板里开。
- 渲染层是普通 script 共享全局作用域（边界检查②会扫），**函数名一律 `bm` 前缀**（bmRefresh / bmRenderList…），别跟 pet renderer 的全局函数撞名。

## 二阶段计划（写在这防走样）

- 桌面最底层嵌入（WorkerW 壁纸夹层）——Electron 里是底层偏方，等面板功能跑稳再上
- ntfy 收信 + 「已收录」回执（`inbox.ts` 规划位；阿里云自建，缓存设长，带访问密码）
- 手机收发箱 APP 是**独立项目**，不在这个仓库里

## 验收

1. `npm run build` 过
2. `npm test` 过（含 `testkit\tests\bookmark-store.test.ts`）
3. `node 检查边界.mjs` 过（bookmark 只认 shared，零越界）
4. 上机人工验：Alt+S 呼出/收起、毛玻璃质感、记一条/删一条/改交给谁、托盘「书签台（随手记）」入口
