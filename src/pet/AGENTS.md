# pet —— 窗口、画框和它里面的一切

**这块管什么**：右上角那个木框小浮窗（物理 480×290）。窗口怎么建、放哪、什么形状、托盘菜单，以及画框里的座位/小人/状态框/右键菜单。**2026-08-14 起：桌面幼苗已移除**（`.pet { display:none }`，元素保留避免报错），功能全部集成到画框窗口（按住画框拖窗口、右键菜单）。

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

- 🚨 **桌面幼苗已移除（2026-08-14）**：`.pet { display: none !important }`，元素保留（pet.js/boot.js 还有引用，删了会报错）。动画/姿态全部不可见，pet.js 的 `beginPetDrag`/`endPetDrag` 已通用化成 `(event, targetEl)` 供画框拖动用。**不许把 .pet 恢复显示**（用户拍板不要幼苗）。
- 🚨 **拖动 = 按住画框（`.scene-frame`）移动整个窗口**：boot.js 绑 scene-frame 的 pointerdown（排除 `.seat-filled`/`#status-note`/`#pet-menu`），窗口全屏可拖、锁工作区内、位置保存。
- 🚨 **右键画框任意处 = 功能菜单**（`#pet-menu`）：详情/设置/藏起来/测试通知/打开日志/退出。新增 ipc `window:show` / `window:open-logs` / `window:quit`（window-ipc.ts）+ preload `showWindow/openLogs/quitApp`。托盘保留同样功能。
- 🚨 **窗口物理尺寸固定 480×290**（`PET_WINDOW_SIZE`），按 `screen.getPrimaryDisplay().scaleFactor` 换算逻辑像素——**必须在 createPetWindow 里算（ensurePetWindowSize），模块顶层访问 screen 在 app ready 前会挂**。默认右上角（`PET_PHYSICAL_MARGIN`=16 物理像素）。
- 🚨 **座位定位用百分比**（`.seat-pos-0~8`，相对 `.agent-seats` 的 aspect-ratio 容器），跨缩放自适应；`--pet-band` 固定 8px（面板弹出时画框+幼苗一起隐藏，:has 规则）。
- 🚨 **背景 = 用户图 v2**（`assets/classroom.png`，1672×941，圆角木框，四角已透明化），`object-fit: contain` 完整显示；画框（`.scene-frame`）自带交互层+16px 圆角裁切，图自带的木框不再重复画 padding/边框。
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
- 🚨 **座位环境 = 9 个固定座位格**（v0.1.23 从气泡条改版）：状态框下面 3×3 网格，常驻——没会话时显示淡空位。
  每个座位三层：椅子（底）→ 工位台（中）→ 小人（前景，`assets/avatars/<agent>.png`），右上角状态灯。
  开一个 CLI 会话 → 那个座位「抱出」小人；会话关了 → 小人消失留空位。
  灯色绿=工作中/黄=休息中/红=卡顿·故障（working/thinking/waiting 超 5 分钟没动静算卡顿，10 秒定时重算）。
  点有人的座位走 `focusAgent`（带 originPid 切回那个终端）。**面板弹出来时座位区整区隐藏**（styles.css 的 `:has()` 规则）。
  小人素材：`renderer\assets\avatars\`（构建自动拷进 dist），没放图时 img 加载失败被 boot.js 的 capture error 委托隐藏，露出 CSS 像素小人占位；
  文件命名 = agent 标识 + .png（pi.png / opencode.png / claude-code.png / hermes.png / grok.png / codex.png），约定写在目录里的 `读我·小人素材放这.txt`。
- 「知道了，返回终端」要按事件带来的进程号切回那个终端，不能只按名字瞎猜（分屏会切错）。
- 2026-08-13：Grok 只回 `grok.exe` 命令行。标题里有 Grok 的续枝面板、浏览器页都不是当前 Agent。日志里切错过 `pwsh | 续枝 · Grok CLI` 和 `Tabbit Browser | …Grok…`。

## 欠账（拆分时发现的，2026-08-12 已清零）

✅ 面板互斥的 8 处互调已治好：`shell.js` 新增 `openPanel`／`restoreInteractionAfterPanelClose`／`refreshPetPose` 三个调度口，
抽屉、设置、询问权限、完成弹窗四家面板只报「我要开了」，不再互相点名。`检查边界.mjs` 的 `debt` 已清空。
以后新面板开合也走 `openPanel(which)`，别自己摸别家的函数。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
