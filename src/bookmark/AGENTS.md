# bookmark —— 书签台（完全隔离的大板块）

**本块归哪个项目**：看板是隔壁项目 `应用\书签工具\` 的电脑端（2026-09-24 资料搬回去），只是代码寄住在桌宠程序里。设定库 `书签工具\设计思路（看板·聊定的设定·一条三本账）\`、维修记录 `书签工具\维修（排障）\` 都在那边；本文件只管代码怎么摆。只改本块时，桌宠的项目资料不用看。

**这块管什么**：随手记 / 网址收藏 / 「交给谁」标记的独立板块，2026-09-10 界面改版成 **「Agent 看板」**（照用户原型图：💭待定区置顶 + 各 agent 分组任务行，分组清单无限加，行尾无确认钮——自动同步）。2026-09-09 用户拍板并入桌宠当常驻壳——**一个壳两个项目**：代码一个区、数据一个库、与桌宠本体零共享状态，后期想拆整块搬走。

**看板分组与待定的约定**（手机端收发箱同款约定，接 ntfy 时对齐）：
- 条目归属看 `assignee` 字段：空 = 普通条目进 💭待定区、交接单（kind=handoff）进 Agent分组页底部的交接单专区；值 = 对应 agent 组（大小写不敏感对齐）
- 分组清单存在 `<appDataRoot>\bookmark\agents.json`，真名单以主进程 AgentRoster 为准；assignee 指向已删除的组时条目回落待定区
- 外来新增入口 = `BookmarkStore.add(input)`（含 dedupeKey），ntfy 收信接线时直接调，不走 UI

| 文件 | 管什么 |
|---|---|
| `agent-watch.ts` | 交活联动（2026-10-29 设定25：别加钩子，只靠看板程序）：盯本机 Claude Code（`.claude\projects`）、Pi（`.pi\agent\sessions`）、Antigravity（`.gemini\antigravity\brain\…\transcript.jsonl`）的会话记录，fs.watch 有变化才读新写进来的那截；`parseSentLine` 只认他发的话（AI 回的、工具结果、isMeta、子助手都不算），`findHandoffs` 认单独文件路径和「接第 N 条 / 接捆 N」，`windowNameFor`＝家名-会话号末 4 位。panel-window `startHandoffWatch` / `onAgentSent` 标「那个窗口 在干」，`expireHandedOut` 把一直没发出去的「已交出」过 3 分钟清掉（`BOOKMARK_HANDOUT_EXPIRE_MS` 可改）。验证脚本给假用户夹 `BOOKMARK_WATCH_HOME` 才盯，隔离实例不读真聊天记录 |
| `coordination.ts` / `dispatch-cli.ts` | 明确启用的多人派工：每捆一个窗口、逐条领取、调度收件箱、用户验收后清理；普通捆不登记，不启动模型或后台工兵 |
| `skills.ts` / `renderer/dispatch.js/.css` | 读取项目技能正本；Ctrl 多选后右键「捆成一捆」（设定21，以最后一次为准）、技能页、协同捆复制领取命令；不替用户打开执行窗口。技能页（2026-11-14 用户：卡太大、看不完）：一个技能一行＝名字＋`功能`，单击展开正本，右键「详情」（`说` 上段、横线、`界` 下段）和「复制路径」；三样都读各份 md 开头那段同名字段（`listBoardSkills` 的 feature/say/edge），新加一份技能卡要在开头补这三行 |
| `organizer.ts` | AI 整理捆（设定21，第五版 2026-10-13）：「整理一次」＝先读条目（`runItemNotes`：每条单独问一次、带它自己的每张图，用大白话写项目名／小标题（开头点明项目，50 字起）／小结，指纹带读条目规矩、规矩一改全部重读，存 `AI条目小结.json`，内容指纹变了才重读；板上每条第一行显示小标题（所有组、交接单一样），原文和详情收起，点小标题直接改原文、点别处存好收回（`bmOpenBodies`、`bmCollapseSoon`，2026-10-15），IPC `bookmark:organizer:notes`）→ 每组新条目拿小卡片出题给便宜模型（模型可加任意一家 OpenAI 式接口，每个自带地址＋钥匙，老格式读时自动搬家）、回 JSON 带理由逐条过筛，只走 store 的 `aiJoinBundle` / `aiCreateBundle`；AI 捆里加了条目就 `askBundleName` 重写捆名（`aiRenameBundle`，用户起名的不改，捆名写法 `BUNDLE_NAME_GUIDE` 一处、最长 `MAX_BUNDLE_NAME`=39）；接着「检查」整组（含用户捆的）挑放错的，只挂提示不挪（`runChecker`，组指纹没变不再问）。规矩正文不在代码里：仓库根 `skills（看板内置模型用·整理捆的规矩）` 一步一份 md，`loadRule` 读进来成 `ITEM_RULES` / `ORGANIZER_RULES` / `BUNDLE_NAME_RULES` / `CHECK_RULES`（`{{}}` 拿代码常数填；读条目和捆标题两份规矩页只读；`copy-assets.mjs` 拷进 dist）。问模型一律走 `askJson` → `chatAny`：对面一时忙按 `retryPlan` 重拨，还不通换设置里下一个有钥匙的模型（挂了的 10 分钟内先跳过，换过记一行「换模型」），回的 JSON 读不懂当场再问一次，`repairJson` 补字里的英文双引号；一轮有「没成」的，panel-window 5 分钟后「补跑」，最多连补 3 次，程序卡死的规矩 `hardRulesText` 拿常数现拼。全部重来＋撤销在 store（`aiResetAll` 存 `bookmarks.json.reset-undo.json`、`undoReset`）。panel-window 管定时器和看板数据夹里的 `organizer.json`（模型和钥匙）、`AI整理规矩.md` / `AI检查规矩.md`（用户改过的规矩）、`AI整理记录.json`（一行一件事，条目删了跟着删，最多 50 次）、`AI整理提示.json`（小橙点、知道了、组指纹）；旧 `AI整理记录.md` 不再读写。界面：设置浮层一行入口＋弹窗口（`bmOpenOrganizerDialog`：整理捆页两个钮＋整理记录、规矩页），条目右边小橙点 `bmBuildHintDot`，气泡 `bmBindBubble`；验证 `scripts/verify-bookmark-organize.mjs` |
| `store.ts` | 本地库：增删查改（updateText 改正文/链接，输入行自动存档用）、「交给谁」标记、dedupeKey 去重（手机离线重发防重复入库）；条目带 `detail`（详情，交接单等长内容）与 `kind`（note 普通 / handoff 交接单 / dispatch 派活单），旧库读入自动补齐默认；JSON 原子写；捆一捆与 AI 领活（设定15）：`bundleId/claimedBy/claimedAt`、`bundleWith`/`claimNext`/`done`（必须带用户原话）/`release`；派活单（设定23）：`batchId`（换组不清）、`addDispatchBatch`（1～3 张）、`dispatchLaunchable`（同批没人领的，最多 3 张），`aiMovable` 挡掉派活单；`onSaved` 存盘后回调（同步小文件用） |
| `item-files.ts` | 一条一份小文件（设定24）：`formatItemFile` 一条的 md 正文、`syncItemFiles` 照看板对齐 `<数据夹>\条目（一条一份）\<id>.md`（变了才写、没了就删、别的文件不碰）；派活单撞文件检查 `parseAllowedFiles`（拆「只许动」那一行；括号里的不切、跟在斜杠后面的括号备注扔掉，夹名自带的括号留着）/ `findFileConflicts`。panel-window 存盘后 300ms 对齐（`scheduleItemFileSync`），IPC `bookmark:item-file`（点号码复制路径）、`bookmark:launch-batch`（一键启动 `launchDispatchBatch`：先查撞文件，再逐张 `openAgentShortcut(…, true)` 等贴完开下一张；命令行 `launch` 走同一个函数） |
| `pi-model.ts` | 一键启动挑 Pi 模型（2026-10-16）：`readPiModels` 读 Pi 设置的 `enabledModels` 和上次用的、`setPiModel` 改 `defaultProvider/defaultModel`＋思考档 `max`（＝替用户按一次 Ctrl+E）。开窗照旧走快捷方式不传 `--model`（Pi 启动器铁律）。测试实例不写；`BOOKMARK_PI_SETTINGS` 指到假文件才写。IPC `bookmark:pi-models`，菜单 `bmPiModelPicker`，命令行 `launch <号码> --model` 端点 `POST /launch`（`handleCliLaunch`，异步，单独一个口子） |
| 撤回（设定22，2026-10-13） | `store.userAction` 记一步（只记这一步动到的条目原样和前一条）、`store.undo` 放回；panel-window 看板改动 IPC 一律包 `act(...)`，🚨 新加能改东西的 IPC 也要包，不包就撤不回；renderer `bmUndo`（Ctrl+Z，打字时不管）。删除（2026-10-16）：Delete 删一条，跟 Ctrl+X 一个认法（点过选中的优先，没选中删鼠标指着的 `bmHoverTaskId`）；批量剪切（2026-10-27）：Ctrl 点选的（`bmSelectedTasks`，跨组、在干的都能选，捆成一捆时才拦）按 Ctrl+X 优先剪这几条，`bmClip={ids}` → `bmStartCarryMany` 拿着走 → `bmDropMany` 一次 IPC `bookmark:move-many`（`store.moveMany`，一个 `act`，Ctrl+Z 一步全回）；取消剪切（2026-10-27，照 Windows 资源管理器）：Esc、同一样再按 Ctrl+X、点底部提示条「取消」都走 `bmCancelClip`，提示条 `bmSyncClipBar` 在 `bmClip` 每次变时调；拿着走时 `body.carrying` 禁选字。找一摊活（2026-10-27）：页签栏「🔍 找」→ IPC `bookmark:search`（`organizer.ts` 的 `searchByText` 按字找＋`askSearchProjects` 让整理用的小模型从已认出的项目名里挑同一个东西，小模型不通只按字找），找到的直接放进 `bmSelectedTasks`（就是 Ctrl 点选），接着 Ctrl+X 一起剪；分捆过筛一捆一个项目（`validatePlan` 按读条员认出的项目名卡，认不出的不拦）。交给哪套系统（2026-10-27）：`forSystem` 字段（根／燊一修，只存名字），命令行 `handoff --for`、右键「交给哪套」（IPC `bookmark:set-for-system`）；板上标题前挂 `.for-system` 名牌＋左边同色粗边，AI 读到的标题前缀「【给X】」（`board-index.ts` 的 `rowTitle`）、领活和单独文件各一句提醒；大标题右键「删除这一捆」走 IPC `bookmark:remove-bundle`，一个 `act` 里删完，Ctrl+Z 一步全回来。详情单击就改：`store.updateDetail`、IPC `bookmark:update-detail`、renderer `bmBuildDetailEditor` / `bmDetailCommit`（`bmEditingField` 分正文和详情） |
| `appearance.ts` | 看板外观纯函数：透明度解析/夹取（范围 0.30–0.95，默认 0.6，坏档回落默认）；存取 IO 在 panel-window（appearance.json） |
| `zoom.ts` | 看板字号纯函数（设定20）：档位 50%–200% 一档 10%、zoom.json 解析、哪个键算调字号；接线在 panel-window `wireBoardZoom`（看板窗口 before-input-event + zoom-changed，🚨 不走 globalShortcut） |
| `projects.ts` | 📁 项目文件夹（2026-09-11 第三页签；2026-09-24 新建夹自带设计思路、执行过程两份稿和空资源包）：真实文件夹+真实 md 存 bookmark\projects\（paths.bookmarkProjectsDirectory）；纯函数（名字校验 sanitizeEntryName/路径安全 resolveProjectPath 防 ../ 穿越）+IO（列表只露夹和 md/建夹/建 md 自动补后缀落标题行）；open 由 panel-window 调 shell.openPath 走系统默认程序；UI 在 renderer 项目页（悬停夹自动弹目录预览、单击进夹、新建夹/md）；手机端不做此功能（用户拍板）。项目行尾小按钮（2026-10-29）：只挂项目根那层的夹，每个项目自己的账 `.小按钮.json`（没有＝默认设计思路、执行过程、资源包），`readProjectKit` / `editProjectKit`（加、拿掉不删文件、左右换位置）/ `kitCandidates` / `createKitEntry`（新建的夹是空夹），IPC `bookmark:projects:kit`；renderer `bmBuildProjKit`、「＋」菜单 `bmShowKitAddMenu`（起名框回车或失焦就建）、按住左右拖 `bmBindKitDrag`（跟条目同一个手感：挪过 5 像素就是拖）；项目页 Ctrl+Z 先退小按钮的账 `bmKitUndo`（`set` 整排换回、`discardKitEntry` 撤新建：没写东西才删文件），退完才走看板撤回。交给 AI 和删除（2026-11-14 用户：照 Agent 分组复刻、右键能删）：`projectLineForAgent` 拼那几行（完整路径＋项目夹＋同夹还有啥），IPC `bookmark:projects:copy-line`（右键「复制给 AI」）、`bookmark:projects:drag-out`（项目行和小按钮拖出窗口边，`startDrag` 拖那份文件或那个夹，`bmBindDrag` 的 `dragOut` 传函数就走它）、`bookmark:projects:delete`（`shell.trashItem` 进回收站，不弹确认、Ctrl+Z 退不回，项目根下一层的顺手从小按钮账上划掉）；不标「已交出」（项目文件没有条目 id） |
| `cli-server.ts` | CLI 接入服务：主进程内 127.0.0.1 小服务（端口+token 写 cli-port.json），agent 命令行读写看板（add/list/handoff/remove）；数据只走 panel-window 注入的适配器，绝不直写 bookmarks.json（主进程内存会覆盖直写）；领活三件套（设定15）`next`/`done`/`release`，领活说明只在 `formatClaimMessage` 写一次，所有 AI 同一份 |
| `inbox.ts` | 收信+回执接线（2026-09-10 接通）：连邮局收手机消息→入 store→发「已收录」回执→通知面板刷新；断线指数退避重连+lastId 续读补收；配置读 `<appDataRoot>\bookmark\ntfy.json`（缺文件/坏档不启动不炸）；逻辑移植自通道夹 receiver.js，一切异常内部消化 |
| `board-index.ts` | 按号码读（2026-10-13 用户：说「第 7 条」「捆2」AI 只读点名的）：`indexBoard` 照看板同一个数法编号——2026-10-15 起全板统一（各组照组名单 → 交接单专区 → 待定，条目号、捆号一路往下接，一个号只有一条；🚨 跟 renderer `bmRenderBoard` 算起点 `bmNumberStart` + `bmFillTaskList` 一处两份，改一边必须改另一边）、`formatBrief`（list 不带 --json：只出号码和小标题）、`formatShow`（show：不用写组名，只吐点名那几条全文；写了组名号不在那组时提一句）、`parseShowSpec`（7 / 7-9 / 7,8,9 / 捆2）；CLI 端点 `GET /view`，数据由 panel-window 的 `boardNames` 适配器给（组名单、小标题、捆名） |
| `dock.ts` | 纯函数：贴右缘几何（宽=工作区1/3顶到底）+ Win32 沉底常量；零依赖好单测 |
| `templates.ts` | 要求模板（设定12/15）：列模板夹 `<appDataRoot>\bookmark\要求模板\` 里的 md、拼复制文字（模板＋「## 这次的事」＋这条）；「启动 Agent · 带编程」用其中的 `带编程.md`；纯函数＋只读 |
| `checklist.ts` | 打勾清单（2026-10-28）：纯函数——`parseChecklist` 读 AI 交的 md（两层，编号按结构重排）、`toggleItem` 拨开关（勾上一层＝小项一起勾，小项全勾完上一层自动算完）、`checklistProgress` 按上一层数进度、`formatChecklist` / `formatPending`。存在条目的 `checklist` 栏，进度句子在 `progress` 栏（log 命令，原话 detail 不动）。store `setChecklist` / `tick`：全勾完 `closeWithLinks` 自动收掉连管着的条目、写数据夹「做完记录（最近50条·看板自动写）.md」。命令行 `清单` / `勾`（cli-server `handleChecklistRequest`，号码或 id 都认），勾的规矩只在 `checklistRules` 一处；副本分两份 `<id>.md`（清单）＋`<id>（原话）.md`（`formatItemFiles`）；看板上 `bmBuildChecklist` 小方框，IPC `bookmark:tick` 包 `act`（Ctrl+Z 能撤）。验证 `scripts/verify-bookmark-checklist.mjs` |
| `handoff-hygiene.ts` / `issue-guard.ts` | 交接单自己收尾（2026-11-03 设定26，毛病记录维修夹 03～07）：`handoff-hygiene` 纯函数放阈值和算法——掉线 `STALE_CLAIM_MS`（1 小时）、久没动 `STALE_DAYS`（7 天）、同一件事 `SIMILAR_TITLE`（0.28，`titleSimilarity` 按相邻两字算）、`lastActiveAt` / `idleDays`；🚨 renderer 开头 `BM_STALE_CLAIM_MS` / `BM_STALE_DAYS` 同一套数，改一边改另一边。store：`claimNext` 点名领时 `takeOverStale` 接走掉线单（会话记录 `agent-watch.ts` `lookupWindow`，只认「家名-末 4 位」）、`touch` 记 `touchedAt`、`hold` / `unhold`（挂起的按组领跳过、点名 next 自动取消）、`checkCloseGuard`（tick 全勾完那下和 done）。`issue-guard` 收单把关：这张领走以后有提交动了 `src/bookmark`，维修夹或设计夹得有这期间改过的 md（`BOOKMARK_ISSUE_DIRS` 可换），他亲手勾不拦、git 不在放行。cli-server `/handoff` 拦像的（409，`--new` 放行）、`/hold` `/unhold`；board-index 和 renderer `bmGroupRecords` 都把挂起的排专区最后（号码对得上）；renderer `.held-toggle` 收起挂起的、`.task.idle` 淡下去、`.claim-stale` 灰 ♻️。验证 `bookmark-handoff-hygiene.test.ts`、`scripts/verify-bookmark-hold.mjs` |
| `inline-images.ts` / `image-ipc.ts` | 条目贴图（2026-09-24 设定16）：正文里存图片标记 `[图片:image-….png]`，真图存 `attachments\`；`image-ipc` 只收图片字节、解码后存 PNG、读图只认本夹文件名；交给 AI 时 `imagesForAgent` 把标记换成「图片文件：完整路径」；图片标注（设定16第三版）不烧原图，单独存 `<图>.marks.json`（marks＋整体说明 summary）＋ 带编号的 `<图>.marked.png`（`bookmark:image:marks:get/set`），交给 AI 时附整体说明和编号清单（`describeMarks`，标注只说大约这附近） |
| `renderer\inline-images.js/.css` | 贴图编辑框：Ctrl+V 或框里右上角的小图片图标（不另占一行，设定16）贴进光标处，有图时换成可编辑的图文框、显示缩略图，点缩略图看大图（毛玻璃边框）、打开就能标（`bmBindMarks`：标注 / 框 / 箭头一套流水号，马卡龙橙红，整体说明框＋每个标注一行说明，自动存、没有保存钮，按住编号拖、Delete / Ctrl+Z）；贴图或开大图途中 `bmImagesBusy` 压住重画和失焦提交 |
| `launch.ts` | 启动 Agent 开窗贴字（设定15第四版）：🚨 **开哪个程序在设置文件 `<看板数据夹>\启动哪个程序.json`**（2026-10-24，两套系统共用一份；没有就照 `DEFAULT_LAUNCH` 写出来；每次开窗现读）：每组一串候选按顺序找，「开」只写名字＝桌面快捷方式、完整路径＝就开那个文件（E 盘入口夹的启动器两套都有），每个候选自带新窗口 / 程序名 / 多等毫秒；新加一家填一组、不改代码。假桌面（`BOOKMARK_AGENT_SHORTCUT_DIR`）时完整路径一律不认，免得验证脚本开出真 AI 窗口。默认：`agentShortcutFor` 组名→候选（Claude→`Claude Code 一` 或 `Claude Code 根`、ChatGPT→`Codex`、Pi Agent→`Pi 编程智能体`、Antigravity→`Antigravity 反重力CLI`（`settleMs` 12 秒：开窗先登录）、Hermes→`Hermes`），桌面程序另带程序文件名 `app`（🚨 Codex 桌面版叫 `chatgpt.exe`，不是 codex.exe）；命令窗口走 `pasteIntoNewWindow` 认新窗口→等启动好→还在最前面才按一次 Ctrl+V，只往开窗前没有的窗口里贴；桌面程序走 `pasteIntoAppWindow` 按程序名认→连续在前面 5 秒→Ctrl+N 新开对话→Ctrl+V（Windows 能力由 panel-window `loadLaunchWin32` 传进来）。🚨 **只按 Ctrl+V / Ctrl+N，绝不按回车**；启动句在 Ctrl+N 时就进剪贴板（紧跟着写再贴会被剪贴板工具占住、贴空）。自测和验证脚本（带隔离数据夹 `AGENT_PET_HUB_HOME`）只报会怎么做、不真开，🚨 别改回只看「常驻」——验证脚本也常驻，2026-09-24 就这样误开了 11 个真 Claude 窗口；`BOOKMARK_AGENT_SHORTCUT_DIR` 指向假快捷方式夹时才真开（真机验证用） |
| `board-sync.ts` | 手机同步看板（设定19）：`buildBoardSnapshot` 抄整板（不带本机图片路径）、`startBoardPublisher` 每 5 秒看变没变、变了发中转站 `bookmark-board`（每 6 小时补发）；`parsePhoneOp` / `applyPhoneOp` 照做手机发来的挪组 / 删条命令（只认 assign / delete）。发不出去只记日志不连坐 |
| `sleep-mode.ts` | 两档（设定18）：`parseBoardMode` 读 `mode.json`（只认 sleep，别的都日常档）、`planNudges` 睡觉档到点给哪几组开窗（有活没人干、同一回只开一次）；纯函数，定时器和开窗在 panel-window `runSleepCheck` |
| `agents.ts` | Agent 看板分组清单（默认五组 Claude/ChatGPT/Pi Agent/Antigravity/Hermes + 自定义无限加；2026-09-24 加 Antigravity 时，老名单靠 `agents-seen.json` 只补一次、插在 Hermes 上面，用户删了不再回来），独立存 `agents.json`；坏档回落默认组 |
| `panel-window.ts` | 面板窗口（Win11 毛玻璃）+ **常驻贴屏/总在其他窗口之下**（koffi 调 user32 SetWindowPos HWND_BOTTOM；失焦即沉底、聚焦不压、2秒兑底）+ **F1 置顶/沉底开关**（2026-09-11 改版三：旧 F3 显示/收起已撤，看板永远常驻显示；F1 提顶 HWND_TOPMOST↔沉回最底，纯函数 pinToggleSteps 在 dock.ts）、本块专属 IPC（bookmark:*，含 agents:*） |
| `preload.ts` | 本块渲染层专属桥（`window.bookmark`），跟 `channel\preload` 互不相干 |
| `renderer\` | 界面三件套（index.html / bookmark.js / styles.css）——**Agent 看板**：💭待定区置顶 + 各 agent 分组任务行，⊕无限加，行尾无确认钮（自动同步）；分组页拖到组头改派，右键「派给」只在待定页（设定12）；行尾复制给用户自己用（常显淡色，点一下复制这条）、左边六个点在 agent 组里是「启动 Agent · 带编程/普通」（设定12）；拖到别条正中间＝捆、捆头六个点整捆启动、条目显示「🔄 窗口名 在干」（设定15）；每组第一格是常驻空白框（设定17，不用按加号），组内输入行**边写边自动存**（2026-09-11 改版三：防抖 400ms 落库+失焦必落盘，无「记下来/取消」钮）；分组页最底部有 **交接单专区**（AI 未派发交接单默认落这，拖组头=派给谁）；独立窗口自含，**不经 shell.js 调度** |

## 对外露出什么

```
initBookmarkPanel  toggleBookmarkPanel  closeBookmarkPanel  BOOKMARK_HOTKEY
BookmarkStore（testkit 单测用）
```

## 依赖谁

**只认 shared**（路径、原子写、日志）。桌宠的 events / channel / pet 一概不认识。
托盘入口是 app.ts 把 `toggleBookmarkPanel` 注进 `PetTrayActions` 的——**本块不许 import pet，pet 也不许 import 本块**。

## 改之前先知道

- 🚨 **改看板先翻问题账，改完写回（2026-11-03 用户：每次修都从零开始想）**：动手前读书签工具 `维修（排障）\00_这夹干嘛的.md` 总表和设计夹对应那号；修了毛病照维修夹模板记一份，加了设定或改了做法改设计夹那号。收单时 `issue-guard.ts` 会查，这期间提交动了 `src/bookmark` 却两个夹都没写，最后一项勾不上。
- 🚨 **隔离铁律：本块出任何故障（断网、崩、超时）都不许连坐桌宠本体。** 收信/网络类逻辑（下一步的 ntfy inbox）必须独立成文件、自带 try/catch 和静默重试。
- 🚨 **数据独立**：`<appDataRoot>\bookmark\bookmarks.json`（`shared\paths.ts` 的 `bookmarkDataDirectory`）。绝不写进桌宠的事件日记/索引，反之一致。坏档挪 `.corrupt-<时间戳>` 存证后空库重来（照 events\event-journal 的先例）。
- 🚨 **置顶层级用 floating，别用 screen-saver** ——那是桌宠窗口的层级（还带 3 秒重申定时器），两个窗口抢层级会打架。
- 🚨 **热键 F1 在 testMode 不注册（app.ts 传 `hotkey: !testMode`），常驻显示同理（`resident: !testMode`），Ctrl+R 整程序重开同理（`liveRestart: !testMode`），别把守卫拆了**——自测会跟真机抢全局热键/弹窗捣乱，也会把测试进程重启掉。
- 🚨 **Ctrl+R＝「升级」（2026-10-24）**：标题栏版本号旁的「升级」钮和 Ctrl+R 同一条路。`relaunchWithNewCode` 用 spawn 后台跑 `scripts/upgrade-build.mjs`（不用 spawnSync：以前编译那几秒整个桌宠卡死、按键攒着连编三遍），编译中再按接着等同一次；看板和桌宠小窗口（app.ts 挂的 before-input-event）都走它，进度一律发看板 `bookmark:reload-progress`。🚨 跑它的是桌宠自带的 `node_modules\electron\dist\electron.exe` 加 `ELECTRON_RUN_AS_NODE=1`，别换回 `npm run build`：电脑上的 node 是碰巧装的（根这边只有 Hermes 带的 22.23）。先编到 `.runtime\dist-next`，编过了才整夹换掉 dist（换不了退成逐个盖），编不过 dist 一个字不动、旧的照用。🚨 `scripts/copy-assets.mjs` 不许用 `fs.cpSync`：根这边唯一的 Node（Hermes 自带 22.23）碰中文路径就崩，Ctrl+R 每次「换新失败」。
- 🚨 **开机加载完就显示（2026-10-24）**：`initBookmarkPanel` 页面没加载完要设 `pendingShow`，以前漏了，开机每次干等 6 秒兜底。验证脚本（`isIsolatedRun`）故意不设、照旧 6 秒：一加载完就显示的话测试窗口马上沉到真桌面底下，截图常卡死（原因没挖到底）。
- 🚨 **真机看板里 Ctrl+R = 编译源码 + 整程序重开**（跟脑图一样，等几秒正常），不是刷新当前页面。开机和手点必须走程序夹 `入口\` 那个门面（唯一入口）。
- 🚨 **看板永远常驻显示（改版三 2026-09-11 拍板）**：旧 F3/托盘的显示/收起逻辑已撤，别加回收起路径；托盘「书签台」入口现在的动作 = F1 同款置顶开关（提上来/沉回去）。
- 🚨 **F1 置顶必须走 SetWindowPos(HWND_TOPMOST)，别碰 Electron alwaysOnTop**——置顶样式和桌宠窗口的 alwaysOnTop(floating) 是两套机制，混用会抢层级打架；沉回时先 NOTOPMOST 摘样式再 BOTTOM。🚨 **置顶期间 2 秒沉底兜底和失焦沉底都不许发 BOTTOM**：微软文档原话，对置顶窗口发 HWND_BOTTOM 会直接摘掉置顶、沉到最底——2026-10-13 前「F1 提上来鼠标一动就没了」就是这个。现在置顶时兜底跳过，点了看板外面（失焦）走 toggleBoardPin 收起；F1 置顶顺手 focus，失焦才认得出来。
- 🚨 **右键菜单、设置浮层在外面一按下就收（2026-10-13，设定12）**：挂 `window` 的 pointerdown 抓最外层，左键右键都算，窗口失焦也收。别改回 document 的 click——点条目文字会被「进改字」的 stopPropagation 截走，菜单就关不掉了。
- 🚨 **默认页是 Agent 分组；状态一律小标（2026-10-13）**：`bmCurrentPage` 初始 `groups`，index.html 里分组页签带 active、「＋组」不藏。在干、AI 捆的、派工占住这类状态用 `bmStatusBadge(图标, 说明)` 出圆角小方块，说明放 title（碰到才冒），别再写成带字的胶囊占地方。
- 🚨 **捆名全交给 AI、闲 5 分钟自动整理（2026-10-13，设定21）**：`runBundleNames` 按捆指纹（条目＋小标题）重写变了的捆名，账本 `AI捆标题.json`，只跳过多人派工捆（`store.aiCanName`）；panel-window `startIdleOrganizer` 每 30 秒看 `boardFingerprint`，停手 5 分钟且跟上次整理完不同才跑。验证脚本（`isIsolatedRun`）不起这两个定时器。
- 🚨 **跨组一步到位、剪切复制后拿着走（2026-10-13，设定21）**：任务条目的拖动和 Ctrl+V 拿着走共用 `bmTaskHitAt`（指着哪个组就按哪个组的捆和缝算，组名或空组＝改派；`bmCanLand` 卡交接单只进 agent 组和交接单专区、普通条目只进 agent 组）和 `bmDropTask`（跨组走 `store.relocate`）。拿着走：`bmClip` 记剪哪条——先认正在改字（没选中字）的那条，再认选中的 `bmPickedTaskId` / `bmPickedBundleId`。🚨 **鼠标碰到哪条就选中哪条（2026-10-24 用户）**：`bmSyncHoverPick` 按鼠标此刻坐标（`elementFromPoint`）认，鼠标挪动、重画完、滚动都重认，出了看板就不选；别改回 pointerenter——上面一条收起、整列往上跳时手没动，pointerenter 不响，以前就认成旧的那条（「点 13 点到 14、16」）。拿着走、拖动中不动选中。按住时剪那套已拆。Delete＝`bmRemove` 删选中的那条（也就是鼠标碰着的，删错 Ctrl+Z；捆不整捆删）。验证 titles ⑥b。
- 🚨 **接活程序自己标（2026-10-29 用户：AI 老忘了标在干，让程序自己判；拖、复制、六个点都是一个逻辑；别加钩子）**：拖出窗口、点号码复制路径、捆标题「复制路径」、行尾复制都调 panel-window 的 `handOut` → `store.handOut`，没人领的标 `HANDED_OUT`（「已交出」）；六个点启动 Agent 走 `claimForLaunch` 直接标看板起的窗口名，一键启动开出去后 `claimNext`。都包 act，Ctrl+Z 一下退一步。撤回账存硬盘 `bookmarks.json.undo.json`（`saveUndo` / `loadUndo`，跟「全部重来」那份 `reset-undo` 不是一份），重开桌宠照样能退；光标在空框里 Ctrl+Z 也退看板（`bmBoxOwnsUndo`）；「已交出」的 ♻️ 点一下放回去，放回去也包 act。`claimFrom` 把「已交出」当空着，`takeOver` 让头一个拿窗口名用 next / log / 清单 / 勾 / done / report 碰它的窗口接走；单独文件开头写一句先 next。Ctrl+C（认谁跟 Ctrl+X 一样，IPC `bookmark:copy-paths`）也算交出去。发出去以后由 `agent-watch.ts` 认出是哪个窗口，没发出去的 3 分钟自己消掉。看板改了数据后 `notifyInboxChanged` 顺手 `invalidate` 催重画（沉在底下时 Windows 有时不重画）。新加任何「交给 AI」的口子也调 `handOut`。命令行 `next 捆2` 靠 `formatShow` 捆头末尾的「· 捆号」认。单测 `bookmark-handout.test.ts`，验证 `verify-bookmark-proj-kit.mjs` ⑥⑦。
- 🚨 **点小标题＝改正文（2026-10-24 用户：小标题归 AI 写，我不手动改）**：有详情的（交接单这类）正文是详情，点小标题直接进详情改字框；没有详情的原文就是正文。别改回「点小标题改那一行原文」。Ctrl+V 进 `bmCarry`，按住左键拖、松开放下，右键 / Esc 不要；在输入框或选中了字时不抢普通复制粘贴（`bmTyping`）。改其中一个，两种操作一起变，别各写一套。
- 🚨 **拖动去向看颜色（2026-10-13 用户拍板，设定21）：变绿＝合并，不绿＝单独放。** 任务列表（能捆的组、或里面有捆的组）拖动走 `bmPlanDrop`：进一捆范围（捆头下半截到最后一条底边往上 16 像素）整捆加 `.bundle-drop` 变绿、松手插进这捆这个位置；压在散条正中间 40% 它变绿（`.bundle-target`）、松手捆一起；别处（块和块之间、捆头上半截、捆底边缘）只露缝、松手单独放，原来在捆里就拆出来。去向由界面算好交给 `store.move(…, into)`（捆号／null），store 只把位置理顺、不再猜；不传 into 才按邻居推断（命令行、待定区用）。别再加「拖到捆底还算在捆里」那种暗规矩——用户看不出来，拆不出来。
- 🚨 **单击和拖动分开（2026-09-24 用户拍板，设定 11）**：鼠标按下挪过 5 像素就是拖（不用等，`BM_DRAG_SLOP`）；没挪就松手是单击，**松手马上响应**（条目文字单击改字、项目页单击进夹/打开 md），按多久都算单击；拖完那一下点击被 `row.dataset.swallow` 吞掉。🚫 别改回「按住 0.3 秒才能拖」（人按下就挪，会被判成单击直接进改字）；🚫 别改成双击、别给单击加延时（当天试过双击，用户：「单击点了半天没反应」）。不走系统拖放，不靠左边小点（小点只管「派给 / 删除」）；别给条目加 `draggable`。待定、分组条目、项目页同一个 `bmBindDrag`（组框不绑，设定13）。
- 🚨 **条目或捆标题拖出窗口边＝拖它们的单独文件（2026-10-28 用户：拖不动，vivo 能拖）**：出界那一下看板里这次挪作废，`bmStartDragOut(ids)` → IPC `bookmark:drag-out-files` → `startDrag({ file, files, icon })`，跟 vivo 拖图补丁同一条路；捆标题拖出去带整捆每条的文件。放进 Claude Code、Pi 贴路径，放进聊天框当附件；拖到浏览器空白页会打开文件（他知道，接受）。startDrag 松手才返回，期间拖回看板的 dragover/drop 一律 preventDefault。🚫 别改回 10-27 那版「假按一下起拖一行字」（`sendInputEvent`）：系统不认，10-28 真机拖进接收窗口一次都没进来。`verify-bookmark-drag-out.mjs` 还按旧版写的，待改；真放进别的窗口要人手验。
- 🚨 **每组第一格是常驻空白框，组标题行不放小加号（设定17，2026-09-24）**：空白框 `bmBuildInsertRow(组, true)` **不带 `task` 类**（不是条目，带了会被拖动、数条目、「第一条」算进去）；找输入框一律 `bmFindInsertInput(组, 是不是空白框)`，别再 `querySelector(".insert-row textarea")`（第一个永远是别的组的）。只有交接单专区留小加号。
- 🚨 **组标题行只放颜色点 / 交接小标 + 组名（交接单专区另有小加号）（设定13，2026-09-24）**：不放条数、不放折叠钮，组高度跟内容走；组框不能拖（只拖组里条目，拖到别组标题=改派）。折叠记录 `bm-collapsed-groups` 已不读不写，别加回来——加回来会让以前收起过的组永远收着。页签上的待定数字另算，保留。
- 🚨 **输入行 / 改字框：画完再放光标，重画不许拔掉正在打的框**（2026-09-24 修，维修记录在书签工具 `维修（排障）\02_点加号冒出的输入行关不掉（已修好）\`）：`bmBeginInsert` / `bmBeginEdit` 要 `await bmRefresh()` 再 focus，别用 requestAnimationFrame 抢跑；`bmRefresh` 画前记下光标在哪个框、画完放回；画的时候 `bmRepainting=true`，新加任何「失焦就收起」的框都要先看它，不然手机一来消息框就自己收了。交接单专区也有同款小加号（手写交接单）。
- 🚨 **拖动期间不许重画看板**（2026-09-24 修残影）：窗口拿焦点、手机来消息都会 `bmRefresh` 整张重画，按着的那条被换掉 → 影子宽 0 且收不回，留成 `⠿01` 窄残影。现在靠 `bmDragActive` 从按下到松手压住重画、松手补画；松手监听挂 `window` 不挂单条；开拖时发现条目已被换掉就作废。新加任何会重画看板的入口，一律走 `bmRefresh`，别绕过它直接 `bmRenderBoard`。
- 🚨 **打字、语音输入时不重画（2026-10-24 看板 Claude 01/02）**：豆包语音说两句就断＝每停一下自动存、存完整张重画、正在说话的框被拆掉重建，输入法跟着断。现在 `bmHoldForTyping`：框里有草稿或在改字、且看板有焦点或正在组字时，`bmRefresh` 只记 `bmRefreshPending`，离开框（focusout、窗口失焦）由 `bmFlushTypingRefresh` 补画。收起（回车、点别处）前先清草稿 / `bmEditingId`，所以收起那一下照常重画。别在打字路径上绕开 `bmRefresh` 直接 `bmRenderBoard`。验证 insert ⑥b。
- 🚨 **鼠标碰到看板就拿焦点（2026-10-24 看板 Claude 01）**：renderer `bmInitHoverFocus` 鼠标进窗口停 250ms → IPC `bookmark:hover-focus`（panel-window `hoverFocusBoard`：先 AttachThreadInput 挂到当前前台窗口的线程再 SetForegroundWindow，记下原来的前台）；没点没按键就移走 → `bookmark:hover-give-back` 还给原窗口。F1 置顶时不做；验证脚本不做，跟 `openAgents` 同一个判法，只有真机验得到。
- 🚨 **「我是不是测试实例」一律问 `shared/paths` 的 `isIsolatedRun()`（2026-10-24）**：认标记 `AGENT_PET_ISOLATED=1`，或数据夹在系统临时夹、`.runtime\test-runs` 下。别拿「有没有 `AGENT_PET_HUB_HOME`」判：两套共用数据时真机也设它（`F:\应用数据\AgentPetHub`），10-22 起真机六个点不真开窗、闲 5 分钟不整理、鼠标碰看板不拿焦点、开机等 6 秒全是这个。新写验证脚本 env 里带上 `AGENT_PET_ISOLATED: "1"`。
- 🚨 **输入行自动存档的落库纪律（改版三 2026-09-11，用户原话：写了就是写了）**：一份草稿只对应一条——首笔 `add`，之后 `updateText` 改同一条（IPC `bookmark:update-text`），别一份草稿存出好几条；打字防抖 400ms，失焦/回车/⊕收起必落盘；框清空=把存出来的那条删掉；落库后重画要把草稿文字+焦点还回去，别把人正在打的字冲掉。
- 🚨 **毛玻璃常亮（2026-09-24 设定14）**：失焦/亮窗后 `keepAcrylicLit` 补发 `WM_NCACTIVATE(TRUE)`，不然 Win11 失焦就把毛玻璃换成死灰。只管外观不抢焦点；别删、别换成 focus/setAlwaysOnTop。颜色在 `styles.css` 末尾「草木皮肤」一整段。
- `backgroundMaterial: "acrylic"` 只有 Win11 有效，构造时 try/catch 回落无材质版本；窗口背景色 `#00000000` + CSS 半透明底，两层一起兜。
- 渲染层保持 sandbox 默认隔离，别图省事开 nodeIntegration。
- 面板里的链接一律走 `setWindowOpenHandler` → `shell.openExternal`，别让网页在面板里开。
- 🚨 **交接单条目（kind=handoff）必须保留交接小标**：序号正下方的细线图标小方块（`.num-col .handoff-badge`，图标 `BM_ICONS.handoff`），不用表情（2026-10-13 用户拍板，设定04），第一行留给标题；底色只比普通条目暖一点点；**交接单专区跟别的组同一个底和边框**，别整块换色（2026-09-24 用户：统一风格上再差异化，设定13）；**交接单专区固定在 Agent分组页最底部、＋加Agent 按钮上方，别处不加**（用户画的黄框位置，2026-09-10 拍板）；未派发交接单默认落专区，拖到哪个组头=派给谁，组内交接单可「收回交接单专区」；交接单接手规矩（next 标在干 → 用户说完工才 done）写在仓库根 AGENT_INTEGRATION.md 的 CLI 节，别删了它。
- 🚨 **透明度只调 renderer 半透明底**（CSS 变量 `--bm-alpha`，滑条在左下角 ⚙ 设置浮层，存档 appearance.json）——acrylic 材质别动；设置浮层结构「一项一行」，以后新设置项往里加行。
- 渲染层是普通 script 共享全局作用域（边界检查②会扫），**函数名一律 `bm` 前缀**（bmRefresh / bmRenderList…），别跟 pet renderer 的全局函数撞名。

## 看板派工（2026-10-07）

- 行为规则唯一正本：项目根 `skills（AI用看板的说明书）/Agent看板/看板派工.md`（2026-10-13 并进 Agent看板 当子文件），界面技能页和 CLI 读取同一份。
- 协同归属与通知保存于看板私有目录的 `bookmarks.json.coordination.json`；报告后整捆归属仍保留。坏档阻止重新领取，保留原文件，不能把坏锁当空锁。
- 只读派工查询不能触发面板刷新，否则会形成“刷新→查询→再刷新”的循环；协同捆从原睡觉档自动开窗名单排除。
- 本次回归：`node scripts/verify-bookmark-dispatch.mjs`（隔离 Playwright：Ctrl两捆、整捆锁、报告等待返回、技能同源、原任务保留）；`bookmark-coordination.test.ts` 覆盖服务端占用与重启。普通捆仍走原流程。

## 二阶段计划（写在这防走样）

- 二阶段计划里那条「桌面最底层嵌入（WorkerW）」的**用户诉求已由改版二（2026-09-10）达成**：常驻 + HWND_BOTTOM 沉底（失焦即沉、聚焦不压）。WorkerW 夹层仍是可选后续，别没事重爬。
- ~~ntfy 收信 + 「已收录」回执~~ **已完成（2026-09-10 接线联调）**：`inbox.ts` 已接通，收信配置在 `<appDataRoot>\bookmark\ntfy.json`（真值看通道夹 deploy\服务器信息）。唯一已知坑：配置文件别带 UTF-8 BOM（代码已刹但别故意踩）
- 手机收发箱 APP 是**独立项目**，不在这个仓库里

## 验收

**只改了本块，就只跑下面这几关**；桌宠自己的 `controls` / `smoke` / `screenshot` / `lifecycle` 不用陪跑。
动了两边共用的（`src\app.ts`、`src\shared\`、`入口\`、Ctrl+R 重开）才两边都跑。
已知基线（2026-10-13 重跑，改之前就红，不算新红）：`verify-bookmark-handoff.mjs` 2 项——①「专区是最后一块、＋加Agent 按钮在它上方」（＋加Agent 早挪进页签栏的「＋组」，脚本还在找旧按钮）、⑦「专区空态提示在」（空态提示早拿掉了）。脚本没跟上界面，不是功能坏了。

1. `npm run build` 过
2. `npm test` 过（含 `testkit\tests\bookmark-store.test.ts`）
3. `node 检查边界.mjs` 过（bookmark 只认 shared，零越界）
4. `node scripts/verify-bookmark-handoff.mjs` 过（交接单专区后台驱动验证：落位/序号下交接小标/详情展开/拖拽派活/收回/自删）
5. `node scripts/verify-bookmark-copy.mjs` 过（行尾复制、六个点启动 Agent（含提示开了哪个快捷方式、测试实例不许真开 Claude 窗口）、右键精简、组头图标、官方标志、捆一捆、真敲命令领活/done/放回去；会动系统剪贴板，脚本自己存了还原）
6. `node scripts/verify-bookmark-images.mjs` 过（贴多图、光标位置、图文编辑、大图、交给 AI、重载改派、移除图、非图片和越界路径拒绝；隐藏窗口跑，不动系统剪贴板）。🚨 样图必须是校验和都对的真 PNG，Electron 解码器很严
   图片标注另跑 `node scripts/verify-bookmark-annotations.mjs`（打开就能标、一套流水号、自动存不动原图、撤销、拖动编号、删光清附属文件、改字框里能标、交给 AI 带编号清单；隐藏窗口）。
7. `node scripts/verify-bookmark-drag.mjs` 过（拖动时看板重画不留残影；按下直接挪就拖、单击马上改字/进夹、拖完不误点；组框拖不动、标题行无条数无折叠、小加号贴组名、交接单专区同底）
7d. `node scripts/verify-bookmark-carry.mjs` 过（所有组第一行都是标题、交接单没有「详情」按钮；跨组拖到两块中间、跨组拖进别组的捆、普通条目进不了交接单专区、交接单拖进空组；Ctrl+X 拿着走进捆、右键不要了、按住时剪、Esc 放弃、输入框里不抢；Ctrl 点选两条一起剪（跨组放到组名上、同组放进捆、Ctrl+Z 一步回）；取消剪切三种办法、底部提示条；交接单「交给哪套」名牌和右键改；「🔍 找」按字找到跨组两条并全选中、接着 Ctrl+X 一起剪；整捆搬家：捆头有捆号、按住捆标题拖进别的组、捆标题上 Ctrl+X 整捆拿着走、Ctrl+C 不碰条目；拖一条再 Ctrl+Z 回原位；单击交接单详情就改、改完 Ctrl+Z 退回；截图在 `.runtime/carry/`）
7c. `node scripts/verify-bookmark-titles.mjs` 过（小标题在第一行、原文收起点开再收；复制钮跟第一行齐平；右键菜单点到别条文字、右键别处、点空白都收起；截图在 `.runtime/titles/`）
7b. `node scripts/verify-bookmark-drag-bundle.mjs` 过（变绿＝合并、不绿＝单独放：捆里调顺序整捆绿、两捆中间不绿松手拆出来、捆下边缘不绿拆出来、拖进别的捆整捆绿插在指定位置、压在散条正中间它变绿捆一起；截图在 `.runtime/drag-bundle/`）
7e. `node scripts/verify-bookmark-drag-out.mjs` 过（按住条目或序号拖出窗口边：系统拖拽起来、带对那行字、看板里不留影子不挪位置、字号 125% 照样行、没出窗口不起）
7e. `node scripts/verify-bookmark-paihuo.mjs` 过（派活单：真命令 paihuo 写一批、没写只许动和超三张拒收、分叉小标和说明、六个点「一键启动 N 个」、测试实例只报会开谁、撞文件一个不开、领到派活单的规矩和单独文件路径、点号码复制路径、删了文件跟着没、改字时 Ctrl+X 剪整条、挑 Pi 模型和命令行 launch（假 Pi 设置文件）；会动系统剪贴板，脚本自己存了还原）
8. `node scripts/verify-bookmark-launch-paste.mjs` 过（🚨 真机真窗口：假快捷方式指向假 AI 程序 `scripts/bookmark-fake-agent.ps1`，外加 powershell 复制改名 `ChatGPT.exe` 冒充 Codex 跑 `scripts/bookmark-fake-desktop-agent.ps1`；真开窗、真按 Ctrl+N / Ctrl+V；验收到的字＝启动句、没有回车。跑的半分钟别碰键盘鼠标，抢了最前面看板按规矩不贴，这关就红）。只动了启动 Agent 才必跑
8b. `node scripts/verify-bookmark-organize.mjs` 过（右键成捆、最后一次为准、剩一条散、交接单专区捆、设置浮层 AI 整理、小橙点和知道了、整理记录气泡、加改删模型、全部重来再撤销）
8c. `node scripts/verify-bookmark-proj-kit.mjs` 过（项目小按钮：默认三块、子夹不挂、「＋」新建 md 点别处就建好、Ctrl+Z 撤新建删空文件、挑已有的、按住左右拖换位置重画还在、右键拿掉文件还在、Ctrl+Z 一步步退；复制路径和行尾复制标「已交出」、交两条按两下 Ctrl+Z 一条条退、六个点启动直接标窗口名、next 换成窗口名；空框里 Ctrl+Z、点 ♻️ 放回去、重开后 Ctrl+Z；联动：假用户夹里 Claude 记录出现路径就标窗口名、没发出去的自己消掉、Ctrl+C 碰着哪条复制哪条、Pi 里说「接第 N 条」也标。桌宠开着时先编到别的夹再 `BM_VERIFY_DIST=<那个夹>` 跑，不动 dist）
8d. `node scripts/verify-bookmark-hold.mjs` 过（交接单收尾：挂起的收在专区最底下、点开收起、排在最后；九天没碰的淡下去挂 🕸️；掉线窗口 ♻️ 发灰；右键挂起、Ctrl+Z 退回、取消挂起。先写好假看板数据再起，`BM_VERIFY_DIST` 能指别的编译夹）
9. `node scripts/verify-bookmark-insert.mjs` 过（每组第一格空白框、没有加号；点进去光标在框里；写了点别处 / 回车落到第二格、框清空，回车后能接着写；打字中途重画不丢；写进哪组落哪组；交接单专区小加号）
10. `node scripts/verify-bookmark-sleep.mjs` 过（两档：档位钮、切睡觉档存档/重开还在/马上给没人干的组开窗、真敲 `next --to` 和 `report`、干完待审块、「可以，删掉」、切回日常档说明回到 done；隐藏窗口）
11. 上机人工验：F1 置顶/沉回最底、毛玻璃质感、记一条（不点钮、边写边自己现身）/删一条/改交给谁、托盘「Agent 看板」入口（=置顶开关）；真机看板里 Ctrl+R 应编译并整程序重开（版本戳变，可出现「🌲 已换新」）
