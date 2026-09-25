# bookmark —— 书签台（完全隔离的大板块）

**本块归哪个项目**：看板是隔壁项目 `应用\书签工具\` 的电脑端（2026-09-24 资料搬回去），只是代码寄住在桌宠程序里。设定库 `书签工具\设计思路（看板·聊定的设定·一条三本账）\`、维修记录 `书签工具\维修（排障）\` 都在那边；本文件只管代码怎么摆。只改本块时，桌宠的项目资料不用看。

**这块管什么**：随手记 / 网址收藏 / 「交给谁」标记的独立板块，2026-09-10 界面改版成 **「Agent 看板」**（照用户原型图：💭待定区置顶 + 各 agent 分组任务行，分组清单无限加，行尾无确认钮——自动同步）。2026-09-09 用户拍板并入桌宠当常驻壳——**一个壳两个项目**：代码一个区、数据一个库、与桌宠本体零共享状态，后期想拆整块搬走。

**看板分组与待定的约定**（手机端收发箱同款约定，接 ntfy 时对齐）：
- 条目归属看 `assignee` 字段：空 = 普通条目进 💭待定区、交接单（kind=handoff）进 Agent分组页底部的 📋交接单专区；值 = 对应 agent 组（大小写不敏感对齐）
- 分组清单存在 `<appDataRoot>\bookmark\agents.json`，真名单以主进程 AgentRoster 为准；assignee 指向已删除的组时条目回落待定区
- 外来新增入口 = `BookmarkStore.add(input)`（含 dedupeKey），ntfy 收信接线时直接调，不走 UI

| 文件 | 管什么 |
|---|---|
| `store.ts` | 本地库：增删查改（updateText 改正文/链接，输入行自动存档用）、「交给谁」标记、dedupeKey 去重（手机离线重发防重复入库）；条目带 `detail`（详情，交接单等长内容）与 `kind`（note 普通 / handoff 交接单），旧库读入自动补齐默认；JSON 原子写；捆一捆与 AI 领活（设定15）：`bundleId/claimedBy/claimedAt`、`bundleWith`/`claimNext`/`done`（必须带用户原话）/`release` |
| `appearance.ts` | 看板外观纯函数：透明度解析/夹取（范围 0.30–0.95，默认 0.6，坏档回落默认）；存取 IO 在 panel-window（appearance.json） |
| `projects.ts` | 📁 项目文件夹（2026-09-11 第三页签；2026-09-24 新建夹自带设计思路、执行过程两份稿和空资源包）：真实文件夹+真实 md 存 bookmark\projects\（paths.bookmarkProjectsDirectory）；纯函数（名字校验 sanitizeEntryName/路径安全 resolveProjectPath 防 ../ 穿越）+IO（列表只露夹和 md/建夹/建 md 自动补后缀落标题行）；open 由 panel-window 调 shell.openPath 走系统默认程序；UI 在 renderer 项目页（悬停夹自动弹目录预览、单击进夹、新建夹/md）；手机端不做此功能（用户拍板） |
| `cli-server.ts` | CLI 接入服务：主进程内 127.0.0.1 小服务（端口+token 写 cli-port.json），agent 命令行读写看板（add/list/handoff/remove）；数据只走 panel-window 注入的适配器，绝不直写 bookmarks.json（主进程内存会覆盖直写）；领活三件套（设定15）`next`/`done`/`release`，领活说明只在 `formatClaimMessage` 写一次，所有 AI 同一份 |
| `inbox.ts` | 收信+回执接线（2026-09-10 接通）：连邮局收手机消息→入 store→发「已收录」回执→通知面板刷新；断线指数退避重连+lastId 续读补收；配置读 `<appDataRoot>\bookmark\ntfy.json`（缺文件/坏档不启动不炸）；逻辑移植自通道夹 receiver.js，一切异常内部消化 |
| `dock.ts` | 纯函数：贴右缘几何（宽=工作区1/3顶到底）+ Win32 沉底常量；零依赖好单测 |
| `templates.ts` | 要求模板（设定12/15）：列模板夹 `<appDataRoot>\bookmark\要求模板\` 里的 md、拼复制文字（模板＋「## 这次的事」＋这条）；「启动 Agent · 带编程」用其中的 `带编程.md`；纯函数＋只读 |
| `inline-images.ts` / `image-ipc.ts` | 条目贴图（2026-09-24 设定16）：正文里存图片标记 `[图片:image-….png]`，真图存 `attachments\`；`image-ipc` 只收图片字节、解码后存 PNG、读图只认本夹文件名；交给 AI 时 `imagesForAgent` 把标记换成「图片文件：完整路径」 |
| `renderer\inline-images.js/.css` | 贴图编辑框：Ctrl+V 或框里右上角的小图片图标（不另占一行，设定16）贴进光标处，有图时换成可编辑的图文框、显示缩略图，点缩略图看大图；贴图途中 `bmImagesBusy` 压住重画 |
| `launch.ts` | 启动 Agent 开窗贴字（设定15第四版）：`agentShortcutFor` 组名→桌面快捷方式（Claude→`Claude Code 一`、ChatGPT→`Codex`、Pi Agent→`Pi 编程智能体`、Antigravity→`Antigravity 反重力CLI`（`settleMs` 12 秒：开窗先登录）、Hermes→`Hermes`），桌面程序另带程序文件名 `app`（🚨 Codex 桌面版叫 `chatgpt.exe`，不是 codex.exe）；命令窗口走 `pasteIntoNewWindow` 认新窗口→等启动好→还在最前面才按一次 Ctrl+V，只往开窗前没有的窗口里贴；桌面程序走 `pasteIntoAppWindow` 按程序名认→连续在前面 5 秒→Ctrl+N 新开对话→Ctrl+V（Windows 能力由 panel-window `loadLaunchWin32` 传进来）。🚨 **只按 Ctrl+V / Ctrl+N，绝不按回车**；启动句在 Ctrl+N 时就进剪贴板（紧跟着写再贴会被剪贴板工具占住、贴空）。自测和验证脚本（带隔离数据夹 `AGENT_PET_HUB_HOME`）只报会怎么做、不真开，🚨 别改回只看「常驻」——验证脚本也常驻，2026-09-24 就这样误开了 11 个真 Claude 窗口；`BOOKMARK_AGENT_SHORTCUT_DIR` 指向假快捷方式夹时才真开（真机验证用） |
| `board-sync.ts` | 手机同步看板（设定19）：`buildBoardSnapshot` 抄整板（不带本机图片路径）、`startBoardPublisher` 每 5 秒看变没变、变了发中转站 `bookmark-board`（每 6 小时补发）；`parsePhoneOp` / `applyPhoneOp` 照做手机发来的挪组 / 删条命令（只认 assign / delete）。发不出去只记日志不连坐 |
| `sleep-mode.ts` | 两档（设定18）：`parseBoardMode` 读 `mode.json`（只认 sleep，别的都日常档）、`planNudges` 睡觉档到点给哪几组开窗（有活没人干、同一回只开一次）；纯函数，定时器和开窗在 panel-window `runSleepCheck` |
| `agents.ts` | Agent 看板分组清单（默认五组 Claude/ChatGPT/Pi Agent/Antigravity/Hermes + 自定义无限加；2026-09-24 加 Antigravity 时，老名单靠 `agents-seen.json` 只补一次、插在 Hermes 上面，用户删了不再回来），独立存 `agents.json`；坏档回落默认组 |
| `panel-window.ts` | 面板窗口（Win11 毛玻璃）+ **常驻贴屏/总在其他窗口之下**（koffi 调 user32 SetWindowPos HWND_BOTTOM；失焦即沉底、聚焦不压、2秒兑底）+ **F1 置顶/沉底开关**（2026-09-11 改版三：旧 F3 显示/收起已撤，看板永远常驻显示；F1 提顶 HWND_TOPMOST↔沉回最底，纯函数 pinToggleSteps 在 dock.ts）、本块专属 IPC（bookmark:*，含 agents:*） |
| `preload.ts` | 本块渲染层专属桥（`window.bookmark`），跟 `channel\preload` 互不相干 |
| `renderer\` | 界面三件套（index.html / bookmark.js / styles.css）——**Agent 看板**：💭待定区置顶 + 各 agent 分组任务行，⊕无限加，行尾无确认钮（自动同步）；分组页拖到组头改派，右键「派给」只在待定页（设定12）；行尾复制给用户自己用（常显淡色，点一下复制这条）、左边六个点在 agent 组里是「启动 Agent · 带编程/普通」（设定12）；拖到别条正中间＝捆、捆头六个点整捆启动、条目显示「🔄 窗口名 在干」（设定15）；每组第一格是常驻空白框（设定17，不用按加号），组内输入行**边写边自动存**（2026-09-11 改版三：防抖 400ms 落库+失焦必落盘，无「记下来/取消」钮）；分组页最底部有 **📋交接单专区**（AI 未派发交接单默认落这，拖组头=派给谁）；独立窗口自含，**不经 shell.js 调度** |

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
- 🚨 **热键 F1 在 testMode 不注册（app.ts 传 `hotkey: !testMode`），常驻显示同理（`resident: !testMode`），Ctrl+R 整程序重开同理（`liveRestart: !testMode`），别把守卫拆了**——自测会跟真机抢全局热键/弹窗捣乱，也会把测试进程重启掉。
- 🚨 **真机看板里 Ctrl+R = 编译源码 + 整程序重开**（跟脑图一样，等几秒正常），不是刷新当前页面。开机和手点必须走项目根 `入口（开发版·跑源码）` 那个门面，不许再指 `release-0.1.xx`。
- 🚨 **看板永远常驻显示（改版三 2026-09-11 拍板）**：旧 F3/托盘的显示/收起逻辑已撤，别加回收起路径；托盘「书签台」入口现在的动作 = F1 同款置顶开关（提上来/沉回去）。
- 🚨 **F1 置顶必须走 SetWindowPos(HWND_TOPMOST)，别碰 Electron alwaysOnTop**——置顶样式和桌宠窗口的 alwaysOnTop(floating) 是两套机制，混用会抢层级打架；沉回时先 NOTOPMOST 摘样式再 BOTTOM，只发 BOTTOM 摘不掉置顶样式。
- 🚨 **单击和拖动分开（2026-09-24 用户拍板，设定 11）**：鼠标按下挪过 5 像素就是拖（不用等，`BM_DRAG_SLOP`）；没挪就松手是单击，**松手马上响应**（条目文字单击改字、项目页单击进夹/打开 md），按多久都算单击；拖完那一下点击被 `row.dataset.swallow` 吞掉。🚫 别改回「按住 0.3 秒才能拖」（人按下就挪，会被判成单击直接进改字）；🚫 别改成双击、别给单击加延时（当天试过双击，用户：「单击点了半天没反应」）。不走系统拖放，不靠左边小点（小点只管「派给 / 删除」）；别给条目加 `draggable`。待定、分组条目、项目页同一个 `bmBindDrag`（组框不绑，设定13）。
- 🚨 **每组第一格是常驻空白框，组标题行不放小加号（设定17，2026-09-24）**：空白框 `bmBuildInsertRow(组, true)` **不带 `task` 类**（不是条目，带了会被拖动、数条目、「第一条」算进去）；找输入框一律 `bmFindInsertInput(组, 是不是空白框)`，别再 `querySelector(".insert-row textarea")`（第一个永远是别的组的）。只有交接单专区留小加号。
- 🚨 **组标题行只放颜色点 / 📋 + 组名（交接单专区另有小加号）（设定13，2026-09-24）**：不放条数、不放折叠钮，组高度跟内容走；组框不能拖（只拖组里条目，拖到别组标题=改派）。折叠记录 `bm-collapsed-groups` 已不读不写，别加回来——加回来会让以前收起过的组永远收着。页签上的待定数字另算，保留。
- 🚨 **输入行 / 改字框：画完再放光标，重画不许拔掉正在打的框**（2026-09-24 修，维修记录在书签工具 `维修（排障）\02_点加号冒出的输入行关不掉（已修好）\`）：`bmBeginInsert` / `bmBeginEdit` 要 `await bmRefresh()` 再 focus，别用 requestAnimationFrame 抢跑；`bmRefresh` 画前记下光标在哪个框、画完放回；画的时候 `bmRepainting=true`，新加任何「失焦就收起」的框都要先看它，不然手机一来消息框就自己收了。交接单专区也有同款小加号（手写交接单）。
- 🚨 **拖动期间不许重画看板**（2026-09-24 修残影）：窗口拿焦点、手机来消息都会 `bmRefresh` 整张重画，按着的那条被换掉 → 影子宽 0 且收不回，留成 `⠿01` 窄残影。现在靠 `bmDragActive` 从按下到松手压住重画、松手补画；松手监听挂 `window` 不挂单条；开拖时发现条目已被换掉就作废。新加任何会重画看板的入口，一律走 `bmRefresh`，别绕过它直接 `bmRenderBoard`。
- 🚨 **输入行自动存档的落库纪律（改版三 2026-09-11，用户原话：写了就是写了）**：一份草稿只对应一条——首笔 `add`，之后 `updateText` 改同一条（IPC `bookmark:update-text`），别一份草稿存出好几条；打字防抖 400ms，失焦/回车/⊕收起必落盘；框清空=把存出来的那条删掉；落库后重画要把草稿文字+焦点还回去，别把人正在打的字冲掉。
- 🚨 **毛玻璃常亮（2026-09-24 设定14）**：失焦/亮窗后 `keepAcrylicLit` 补发 `WM_NCACTIVATE(TRUE)`，不然 Win11 失焦就把毛玻璃换成死灰。只管外观不抢焦点；别删、别换成 focus/setAlwaysOnTop。颜色在 `styles.css` 末尾「草木皮肤」一整段。
- `backgroundMaterial: "acrylic"` 只有 Win11 有效，构造时 try/catch 回落无材质版本；窗口背景色 `#00000000` + CSS 半透明底，两层一起兜。
- 渲染层保持 sandbox 默认隔离，别图省事开 nodeIntegration。
- 面板里的链接一律走 `setWindowOpenHandler` → `shell.openExternal`，别让网页在面板里开。
- 🚨 **交接单条目（kind=handoff）必须保留 📋 标记**，底色只比普通条目暖一点点；**交接单专区跟别的组同一个底和边框**，别整块换色（2026-09-24 用户：统一风格上再差异化，设定13）；**交接单专区固定在 Agent分组页最底部、＋加Agent 按钮上方，别处不加**（用户画的黄框位置，2026-09-10 拍板）；未派发交接单默认落专区，拖到哪个组头=派给谁，组内交接单可「收回交接单专区」；「接完活自己 remove 删掉」的规矩草案写在仓库根 AGENT_INTEGRATION.md 的 CLI 节，别删了它。
- 🚨 **透明度只调 renderer 半透明底**（CSS 变量 `--bm-alpha`，滑条在左下角 ⚙ 设置浮层，存档 appearance.json）——acrylic 材质别动；设置浮层结构「一项一行」，以后新设置项往里加行。
- 渲染层是普通 script 共享全局作用域（边界检查②会扫），**函数名一律 `bm` 前缀**（bmRefresh / bmRenderList…），别跟 pet renderer 的全局函数撞名。

## 二阶段计划（写在这防走样）

- 二阶段计划里那条「桌面最底层嵌入（WorkerW）」的**用户诉求已由改版二（2026-09-10）达成**：常驻 + HWND_BOTTOM 沉底（失焦即沉、聚焦不压）。WorkerW 夹层仍是可选后续，别没事重爬。
- ~~ntfy 收信 + 「已收录」回执~~ **已完成（2026-09-10 接线联调）**：`inbox.ts` 已接通，收信配置在 `<appDataRoot>\bookmark\ntfy.json`（真值看通道夹 deploy\服务器信息）。唯一已知坑：配置文件别带 UTF-8 BOM（代码已刹但别故意踩）
- 手机收发箱 APP 是**独立项目**，不在这个仓库里

## 验收

**只改了本块，就只跑下面这几关**；桌宠自己的 `controls` / `smoke` / `screenshot` / `lifecycle` 不用陪跑。
动了两边共用的（`src\app.ts`、`src\shared\`、打包、`入口（开发版·跑源码）`、Ctrl+R 重开）才两边都跑。
已知基线（2026-09-24，改之前就红，不算新红）：`verify-bookmark-handoff.mjs` 4 项（专区位置、详情展开/收起，外加一处卡住：它第③步单击条目文字当「展开详情」，实际进了改字；2026-09-24 起重画不再冲掉改字框，那条一直在改字状态，第⑥步按文字找不到它而超时——原来第 4 项是空态提示）——都是 `3a981cc` 长按拖动改版拿掉了旧控件，脚本没跟上。

1. `npm run build` 过
2. `npm test` 过（含 `testkit\tests\bookmark-store.test.ts`）
3. `node 检查边界.mjs` 过（bookmark 只认 shared，零越界）
4. `node scripts/verify-bookmark-handoff.mjs` 过（交接单专区后台驱动验证：落位/📋标记/详情展开/拖拽派活/收回/自删）
5. `node scripts/verify-bookmark-copy.mjs` 过（行尾复制、六个点启动 Agent（含提示开了哪个快捷方式、测试实例不许真开 Claude 窗口）、右键精简、组头图标、官方标志、捆一捆、真敲命令领活/done/放回去；会动系统剪贴板，脚本自己存了还原）
6. `node scripts/verify-bookmark-images.mjs` 过（贴多图、光标位置、图文编辑、大图、交给 AI、重载改派、移除图、非图片和越界路径拒绝；隐藏窗口跑，不动系统剪贴板）。🚨 样图必须是校验和都对的真 PNG，Electron 解码器很严
7. `node scripts/verify-bookmark-drag.mjs` 过（拖动时看板重画不留残影；按下直接挪就拖、单击马上改字/进夹、拖完不误点；组框拖不动、标题行无条数无折叠、小加号贴组名、交接单专区同底）
8. `node scripts/verify-bookmark-launch-paste.mjs` 过（🚨 真机真窗口：假快捷方式指向假 AI 程序 `scripts/bookmark-fake-agent.ps1`，外加 powershell 复制改名 `ChatGPT.exe` 冒充 Codex 跑 `scripts/bookmark-fake-desktop-agent.ps1`；真开窗、真按 Ctrl+N / Ctrl+V；验收到的字＝启动句、没有回车。跑的半分钟别碰键盘鼠标，抢了最前面看板按规矩不贴，这关就红）。只动了启动 Agent 才必跑
9. `node scripts/verify-bookmark-insert.mjs` 过（每组第一格空白框、没有加号；点进去光标在框里；写了点别处 / 回车落到第二格、框清空，回车后能接着写；打字中途重画不丢；写进哪组落哪组；交接单专区小加号）
10. `node scripts/verify-bookmark-sleep.mjs` 过（两档：档位钮、切睡觉档存档/重开还在/马上给没人干的组开窗、真敲 `next --to` 和 `report`、干完待审块、「可以，删掉」、切回日常档说明回到 done；隐藏窗口）
11. 上机人工验：F1 置顶/沉回最底、毛玻璃质感、记一条（不点钮、边写边自己现身）/删一条/改交给谁、托盘「书签台（随手记）」入口（=置顶开关）；真机看板里 Ctrl+R 应编译并整程序重开（版本戳变，可出现「🌲 已换新」）
