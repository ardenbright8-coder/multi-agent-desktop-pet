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

- 🚨🚨 **别再用 `setShape()` 挡点击，它挡不住。** Electron 官方文档白纸黑字：**透明窗口的透明区域点不过去**，而 `setShape` 是实验性 API，在 Windows 上对 transparent＋layered 窗口不生效。页面里那句 `pointer-events: none` 只管网页内部，管不到系统层。
  → 结果就是那个 440×680 的透明矩形一直吃鼠标，人在底下点视频、点别的窗口全点不着（2026-08-12 用户报的 bug，根因就是这个）。
  **现在的正解**：窗口默认 `setIgnoreMouseEvents(true, { forward: true })` 整个让开，`forward` 保证穿透时仍收得到 mousemove；界面用 `document.elementFromPoint` 判断鼠标底下是不是 `[data-interactive]`，是才让主进程临时收回穿透。逻辑在 `window.ts` 的 `applyMouseMode()` 和 `renderer\pet.js` 的 `syncHitTest()`。
  **三种情况必须收回穿透**：面板开着、正在拖、鼠标压在可点的东西上。别漏。
- 🚨 **拖动是「按住拖、松手放」，不是「点一下拿起」。** 旧的点击式拿起有个死结：拖到别的屏幕后幼苗可能不在鼠标底下，就再也点不着、也就永远放不下，窗口卡在"拿起态"一直挡着鼠标。
  按住拖必须配 **pointer capture**（`setPointerCapture`），否则拖快了鼠标甩出窗口，`mousemove` 和 `mouseup` 一起丢，又卡在拖动态。另外 `window.blur` 也接了兜底放手。
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
