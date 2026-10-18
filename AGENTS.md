# 多Agent桌面宠物 · 改这个库之前先读这页

这是代码夹的门牌。下面只写看代码看不出来的东西：不成文的约定、当初为什么这么定、配置文件不会招供的坑。

## 先去读哪份

- **要改某一块的代码** → 那块夹口的 `src/<块名>/AGENTS.md`。十块全有，进那块之前先读它，然后只开那一个文件
- **要动通知、权限、完成弹窗** → 项目根 `弹窗规矩（什么时候该弹·代码怎么改·所有Agent必读）.md`，什么事才配弹窗、钩子输出格式都在那
- **想知道某块什么时候动过、为什么这么改** → 本夹 `00_组合清单（现行版·哪块什么时候动的）.md`
- **改面板长相、文案** → `design（现行设计·表述规则）/` 和本夹 `DESIGN.md`。两份面板参考图是用户敲定的，以图为准
- **接一家新 Agent** → 本夹 `AGENT_INTEGRATION.md`
- **Agent 看板（`src/bookmark/`）的设定和维修记录** → 不在本项目，在隔壁 `书签工具` 项目。看板只是借住在这个程序外壳里
- **跟用户说话、写注释用什么词** → 项目根 `00_叫什么（咱俩说话的统一叫法）.md`。进项目先扫一眼
- **聊定的设定（为什么这么做）** → 项目根 `设计思路（聊定的设定·一条两份）/`，一条两份。新定一条就往里加，不建 `docs/adr/`
- **拆好的任务单** → 本夹 `.scratch/<功能名>/`，一张一个 markdown，用到再建。不用 GitHub 的任务功能；分类用默认五个标签 `needs-triage` `needs-info` `ready-for-agent` `ready-for-human` `wontfix`

## 这库怎么转

一个程序里住着几个互不相干的板块：**桌宠**（盯着各家 AI 的状态，弹询问／权限／完成面板）、**Agent 看板**（`src/bookmark/`）、**Ctrl+Q 命令窗口**（`src/quickcmd/`）、**vivo 截图复制**（`src/vivo/`）。各板块只共用 `shared` 底座，谁崩了都不许连坐别人。右键「板块与内存」（`src/overview/`）列出装了几个、占多少内存。

依赖链单向，`node 检查边界.mjs` 机器卡着：

```
shared（谁都不依赖）
  → interaction → events → channel / pet
  → integrations、bookmark、quickcmd、vivo、overview（都只认 shared）
  → testkit、src/app.ts（装配，可以调所有人，没人许调它们）
```

1. **跨块只准 import 对方根上的入口文件**，名单在 `检查边界.mjs` 的 `publicEntries`。子夹（`renderer/` 等）一律算内部
2. **界面那几份 js 是普通 script，共享一个全局作用域**（`loadFile` 走 file://，ES module 的 import 会被拦）。加载顺序焊死在 `src/pet/renderer/index.html`：`shell → pet → panel → drawer → boot`。只有 `shell.js` 和 `boot.js` 准调别人的函数
3. **面板开合一律走 `shell.js` 的 `openPanel(which)`**，各面板只报「我要开了」，不互相点名
4. 欠账名单 `debt` 现在是空的，**保持空**：越界了就改代码

## 新东西放哪

### 人主动新写的

| 要加什么 | 放哪 |
|---|---|
| 桌宠窗口、画框、座位、托盘 | `src/pet/` |
| 事件收发、会话状态、搜索 | `src/events/` |
| 询问／权限面板的内容和回传 | `src/interaction/` |
| 管道、preload 暴露的接口 | `src/channel/` |
| 看板的任何东西 | `src/bookmark/`（函数名用 `bm` 前缀，防跟桌宠界面全局撞名） |
| 终端里 Ctrl+Q 弹出的命令按钮窗口 | `src/quickcmd/`（改之前读它自己的 `AGENTS.md`） |
| vivo 截图复制（剪贴板补图） | `src/vivo/`；拖图补丁、Claude Code 和 Pi 插件正本、换电脑一键装在 `vivo配套（拖图补丁·插件·一键装）/`（不参与编译） |
| 「板块与内存」窗口 | `src/overview/`。**并入新板块**：新建 `src/<块名>/` 只认 shared → `检查边界.mjs` 登记 → app.ts 起它、往 `blockList()` 加一行 |
| 四家 Agent 的插件／钩子本体 | 项目根 `integrations/`（不参与编译，改协议字段要同步改这里） |
| 跨块共用的小工具 | **三块以上真在用**才进 `src/shared/`。两块在用就放其中一块 |
| 单元测试 | `src/testkit/tests/<名字>.test.ts`，`npm test` 自动扫 |
| 界面验证脚本 | `scripts/verify-<名字>.mjs` |
| 旧版备份、没处理完的素材 | 所在夹里建 `_` 开头的子夹（`_old（…）`、`_素材暂存（…）`）。**下划线开头的夹不会被拷进 dist 和安装包** |

### 脚本自己吐出来的

| 哪个脚本 | 吐什么 | 落到哪 | 旧的怎么办 |
|---|---|---|---|
| `npm run build` | 编译产物 | `dist/` | 每次 `clean.mjs` 清空重建 |
| `npm run pack:local` | 免安装打包盒 | `release-<版本号>/` | **代码夹里只留最新一个**，旧的挪项目根 `_old（改之前的旧版·回滚用）/旧打包版（…）/` |
| `npm run dist` / `pack` | 安装包、绿色版 | `release/` | 拷到项目根 `安装包/`、`绿色版（…）/` 再给人用 |
| `npm test`、`smoke`、`controls` 等 | 隔离数据、截图、报告 | `.runtime/test-runs/<模式>-<时间>/` | 每次编译自动清一小时前的（`scripts/sweep-test-temp.mjs`） |
| `scripts/verify-*.mjs` | 截图、临时数据 | 截图 `.runtime/<名字>/`；临时数据系统临时夹 `bm-<名字>-` 开头 | 临时数据同上自动清，截图每次覆盖 |

🚨 新写测试要建临时数据夹：系统临时夹用 `mkdtemp(join(tmpdir(), "bm-<名字>-"))`（或 `agent-pet-` 开头），或放进 `.runtime/test-runs/`——起成别的名字，编译时就清不到，又会攒成上千个。

以上全部在 `.gitignore` 里，不进 git。

## 改完必须过这几关

0. **提交时自动查**：`.githooks/pre-commit` 跑边界检查和类型检查，几秒。新克隆的库先跑一次 `git config core.hooksPath .githooks` 才生效
1. `node 检查边界.mjs` → 退出码 0
2. `npm test` → 全过。2026-10-18 基线：235 + 4 项
3. 动了界面的，再跑 `npm run controls`、`npm run lifecycle`、`npm run smoke`。controls 基线 `buttons=14 dynamic=6 inputs=4 window=12`

🚨 **`npm test` 和所有 `npm run` 测试都会先清空 `dist/` 再重建，而桌面图标跑的就是 `dist/`。** 用户的桌宠开着时跑测试，等于在它脚底下换地板。跑之前看一眼有没有 `--skip-integration-install` 那个 electron 进程在跑；在跑就提醒用户，或者跑完提醒他重开一次桌宠。
4. 动了接入的，跑 `npm run integration:smoke`
5. **桌面和开机那个图标跑的是本夹的 `dist/`**：它们都指项目根 `入口（开发版·跑源码）/多Agent桌面宠物.exe`。改完 `npm run build`（或在看板里 Ctrl+R），重开就是新代码。`release-*` 打包盒不会跟着变，也不许有图标指它

## 写门牌的规矩

新开一块就在夹口挂一张 `AGENTS.md`，五段：**这块管什么 / 对外露出什么 / 这块依赖谁 / 改之前先知道（踩过的坑）/ 专题**。只写代码里看不出来的。AI 起草的标一句「待用户过目」。

---

_2026-10-01 建（待用户过目）。照编程 skill 的「老代码库保养办法」做的第一轮：换行／编码规定文件、旧打包夹挪出代码夹、下划线夹不进安装包、叫法表、设计思路夹、面板高度跟着内容走、提交前自动查。_
_结构变了这页要跟着改。_
