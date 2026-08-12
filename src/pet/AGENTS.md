# pet —— 幼苗和它那个窗口

**这块管什么**：桌面上那株绿色幼苗。窗口怎么建、放哪、什么形状、托盘菜单，以及幼苗的姿态和外观设置。

| 文件 | 管什么 |
|---|---|
| `window.ts` | 建窗口、显示隐藏、记位置、面板展开时变形。**窗口相关的状态全住这儿** |
| `window-ipc.ts` | 界面发来的窗口类请求：拖动、拿起、面板展开、隐藏 |
| `tray.ts` | 托盘图标和右键菜单（菜单文字随事件中心状态重建） |
| `window-position.ts` | 位置计算：默认位置、拉回可见屏幕 |
| `renderer\shell.js` | 界面底座：DOM 引用、共享状态、总调度 `renderSnapshot`。**必须第一个加载** |
| `renderer\pet.js` | 幼苗姿态、庆祝、随机小动作、拿起放下、大小和活泼程度 |
| `renderer\boot.js` | 绑事件、开定时器。**必须最后一个加载** |
| `renderer\index.html` `styles.css` | 页面骨架和样式 |

## 对外露出什么

```
createPetWindow  getPetWindow  destroyPetWindow  showMainWindow  hideMainWindow
setShuttingDown  isShuttingDown  persistWindowPosition  keepWindowOnVisibleDisplay
setPanelVisibility  setPetPickedUp  watchDisplayChanges
createTray  createTrayActions  PetTrayActions
```

## 依赖谁

`shared` ＋ `events`（要显示快照、托盘要读诊断）。不许认识 channel / interaction 的内部。

## 改之前先知道

- 🚨 **界面这几份 js 是普通 script，不是 ES module。** 页面走 `loadFile()`（file:// 协议），**ESM 的 `import` 在 file:// 下会被拦死**。所以它们靠 `index.html` 里的 `<script>` 顺序加载、共享同一个全局作用域。加新文件就在 html 里加一行，**顺序是 shell → pet → panel → drawer → boot，别调**。
- **透明空白不许拦桌面点击**；幼苗被拿起或面板展开时窗口才变成整块矩形（`updateWindowShape`）。
- 换屏幕、拔显示器之后要把幼苗拉回可见范围，测试在 `testkit\tests\window-position.test.ts`。
- Windows 这台机关了系统动画，桌宠的"自然／活泼"是**用户明确要求的覆盖**，只重开幼苗动作，**不许去改 Windows 设置**；选"安静"就保持静态。
- 姿态只跟着 Agent 状态自动变，**不提供手动动作试演**。

## 欠账（拆分时发现的，还没治）

界面三块之间有 8 处互调（`检查边界.mjs` 每次会列出来）：抽屉、设置面板、询问面板**三者互斥**，开一个要关另外两个，于是 `drawer.js` `pet.js` `panel.js` 互相点名调用。

**怎么治**：在 `shell.js` 里加一个 `showOnlyPanel(name)` 之类的调度口，三家都改成向底座报"我要开了"，互相不再点名。
**为什么现在没治**：这轮的规矩是「整段搬、一行不重写」，改这个属于动逻辑，留到下次单独做，免得混在一起说不清是谁弄坏的。治好了记得从 `检查边界.mjs` 的 `debt` 里删掉对应几行。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
