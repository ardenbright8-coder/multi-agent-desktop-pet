# pet —— 幼苗和它那个窗口

**这块管什么**：桌面上那株绿色幼苗。窗口怎么建、放哪、什么形状、托盘菜单，以及幼苗的姿态和外观设置。

| 文件 | 管什么 |
|---|---|
| `window.ts` | 建窗口、显示隐藏、记位置、面板展开时变形。**窗口相关的状态全住这儿** |
| `window-ipc.ts` | 界面发来的窗口类请求：拖动、拿起、面板展开、隐藏 |
| `tray.ts` | 托盘图标和右键菜单（菜单文字随事件中心状态重建） |
| `window-position.ts` | 位置计算：默认位置、拉回可见屏幕 |
| `focus-agent.ts` | 点「返回终端」时先按进程号、再按标题把对应终端拉到前台 |
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
- 🚨 **窗口尺寸按「幼苗放到最大（140%）」算**，不是按 100%。幼苗顶部对齐窗口顶（`top: 8px`，
  `transform-origin: center top`），放大时**向下长**。
  为什么：① 100% 时幼苗离窗口顶只有 8px，能真正贴到屏幕上沿；② 底部对齐时放大会长出窗口顶部，
  溢出那块会把本该穿透的角落也占掉（2026-08-12 实测踩过）。
- 🚨 **`--pet-band`（262px）是幼苗的地盘，任何面板都必须从这条线以下开始。**
  用户 2026-08-12 的硬要求：不管哪个框弹出来都不许把宠物完全遮住，否则弹了框就没法拖、没法右键。
  `controls` 里有断言盯着「面板顶 ≥ 幼苗底」。
- 🚨 **面板展开时窗口往「下」长，左上角不动**（幼苗贴窗口顶，所以纹丝不动）。
  早先是往左上长（那时幼苗贴窗口底），改成顶部对齐后必须跟着反过来，
  否则一弹面板幼苗就往上跳 400 多像素。
- 🚨 **可点区域只给 `#pet` 和 `#status-note`，别给 `.pet-zone`。**
  幼苗区是 `inset: 0` 占满窗口的，给它 `data-interactive` 等于整块窗口都吃鼠标，
  穿透就全废了（2026-08-12 踩过）。
- **页面缩放已关死**：`setVisualZoomLevelLimits(1,1)` + `zoom-changed` 复位 + `before-input-event`
  拦 Ctrl +/-/0 + 拦 Ctrl+滚轮。幼苗大小走设置里的滑杆，不要第二套缩放（用户明确要求）。
- **状态框摆哪边**：`syncNoteSide()` 按幼苗在屏幕哪半边自动决定（左半屏→框在右，右半屏→框在左），
  让框永远朝屏幕中间展开。托盘「聊天框换个边」可手动翻，**手动翻过就钉住不再自动**。
- 🚨 **界面这几份 js 是普通 script，不是 ES module。** 页面走 `loadFile()`（file:// 协议），**ESM 的 `import` 在 file:// 下会被拦死**。所以它们靠 `index.html` 里的 `<script>` 顺序加载、共享同一个全局作用域。加新文件就在 html 里加一行，**顺序是 shell → pet → panel → drawer → boot，别调**。
- **透明空白不许拦桌面点击**；幼苗被拿起或面板展开时窗口才变成整块矩形（`updateWindowShape`）。
- 换屏幕、拔显示器之后要把幼苗拉回可见范围，测试在 `testkit\tests\window-position.test.ts`。
- Windows 这台机关了系统动画，桌宠的"自然／活泼"是**用户明确要求的覆盖**，只重开幼苗动作，**不许去改 Windows 设置**；选"安静"就保持静态。
- 姿态只跟着 Agent 状态自动变，**不提供手动动作试演**。
- 🚨 **完成弹窗只在某个会话「新进入 done」时弹。** 不许用 lead 身份变化当触发——已经点掉的完成会话一回到队首会再弹一次，看着像乱弹（2026-08-13 实机）。
- 「知道了，返回终端」要按事件带来的进程号切回那个终端，不能只按名字瞎猜（分屏会切错）。

## 欠账（拆分时发现的，2026-08-12 已清零）

✅ 面板互斥的 8 处互调已治好：`shell.js` 新增 `openPanel`／`restoreInteractionAfterPanelClose`／`refreshPetPose` 三个调度口，
抽屉、设置、询问权限、完成弹窗四家面板只报「我要开了」，不再互相点名。`检查边界.mjs` 的 `debt` 已清空。
以后新面板开合也走 `openPanel(which)`，别自己摸别家的函数。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
