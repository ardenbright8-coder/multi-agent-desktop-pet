# overview —— 板块与内存（右键「板块与内存」弹的小窗口）

**这块管什么**：列出程序里装了几个板块、各自在不在跑；整个程序占多少内存、绿黄红、离警戒线还能加几个板块。用户到黄线了就知道新功能该另开一个自启程序。入口：桌宠右键菜单第二项、托盘右键菜单。只认 `shared`。

| 文件 | 管什么 |
|---|---|
| `overview-window.ts` | 入口：`initOverview(getBlocks)` / `openOverview` / `closeOverview`。点了才建窗口，关了就销毁；`overview:get` 给界面数据 |
| `metrics.ts` | 纯函数：进程叫什么（主控、画图帮手、联网帮手、窗口）、绿黄红、还能加几个。警戒线常数在这。测试 `testkit/tests/overview-metrics.test.ts` |
| `preload.ts` | 界面桥 `window.overview.get()` |
| `renderer/` | 界面：每 2 秒刷新一次。函数名带 `ov` 前缀（界面脚本共用全局，防撞名） |

## 对外露出什么

`initOverview  openOverview  closeOverview  BlockInfo  OverviewSnapshot`

## 依赖谁

只认 `shared`。**板块名单不在这块**：app.ts 的 `blockList()` 一个板块一行，注入进来。并入新板块记得往那儿加一行。

## 改之前先知道

- 警戒线：800 MB 黄、1200 MB 红（2026-10-18 定，理由写在 `metrics.ts` 开头）；改数只改那几个常数
- 数的是各进程「专用内存」之和，比任务管理器把共用部分重复算的合计准；总览窗口自己的进程不算
- 窗口平时不开：开着就多一个进程、多占几十兆
- 桌宠右键菜单那个窗口才 97 像素高（物理 173），菜单太长下面会被裁，所以「板块与内存」放第二项

_2026-10-18 建（待用户过目）_
