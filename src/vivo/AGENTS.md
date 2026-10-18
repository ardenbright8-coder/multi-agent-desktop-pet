# vivo —— vivo 截图复制（在 vivo 办公套件点「复制」后，哪都能 Ctrl+V）

**这块管什么**：vivo 截图弹窗点「复制」放进剪贴板的是「一张光秃秃的图」（它的代码是 Electron 的 `clipboard.writeImage`，只有 PNG 和位图）。网页认；Claude Code 在 Windows 上读剪贴板图常失灵；命令窗口 Ctrl+V 只能贴字。这块每 0.3 秒看一眼剪贴板，看到光秃秃一张图，就存成 jpg 到中转夹 `D:\Downloads\vivo办公套件\截图中转\`（只留最新 100 张），再清空重放：这个文件 + 一张图（CF_DIB、PNG）+ 文件位置那行字 + 本块的记号。Claude Code、Pi 拿到图片文件位置会自己打开，这是社区公认最稳的路。只借桌宠程序当入口，不开窗口，只认 `shared`。

| 文件 | 管什么 |
|---|---|
| `vivo-clip.ts` | 入口：`initVivoClip` / `closeVivoClip` / `vivoClipStatus`（给「板块与内存」显示）。轮询、认图、存中转夹、补剪贴板、清旧图 |
| `clip-format.ts` | 纯函数：认不认「光秃秃一张图」、中转夹起名和留几张、拼「复制的文件」和「一张图」两种格式。测试 `testkit/tests/vivo-clip-format.test.ts` |
| `win32.ts` | 剪贴板的 Windows 调用（koffi）：看有没有某种格式、一次放几样、换格式编号 |

## 对外露出什么

`initVivoClip  closeVivoClip  vivoClipStatus  VivoClipStatus`

## 依赖谁

只认 `shared`（日志）。app.ts 装配时调，自测模式不起（别动真机剪贴板）。

## 改之前先知道

- 🚨 **`%APPDATA%\vivoClipdata\` 不是「vivo 复制存的图」**：是 vivo 把**电脑剪贴板里出现的任何图**存一份准备同步到手机（PixPin 截图也会存）。vivo 重启会清。别拿它当中转夹
- 🚨 **认不出是 vivo 放的**：vivo 写剪贴板时主人窗口是空的（2026-10-18 跟踪器实测），所以按「光秃秃一张图」认：有图，没文件、没字、没网页片段、没记号。系统截图工具这类同样光秃秃的图也会顺手补上；PixPin（带文件）、浏览器复制图片（带网页片段）不碰
- 🚨 **写剪贴板不能用 Electron 的 clipboard**：它放不了「复制了一个文件」。所以全走 koffi；放东西得有主人窗口，`win32.ts` 开了一个看不见的只收消息的小窗口（HWND_MESSAGE）
- vivo 一次复制连写两回（隔 0.1 秒），所以剪贴板序号要连续两轮不变才动手，不然会被它第二回盖掉、存两张
- 千问语音输入法每说一句会借用剪贴板（先放字、约 1 秒后放回原样），放回来时带着本块的记号或那行字，不会再转一遍
- 补的那行位置是给命令窗口 Ctrl+V 用的。哪个程序因此多贴出一行字，把 `vivo-clip.ts` 的 `PUT_PATH_TEXT` 改 false
- 实测（2026-10-18）：照 vivo 的写法放一张 1440×3168 的图 → 中转夹多一张 jpg（约 400KB），剪贴板里有 文件 / 图 / PNG / 位置字 / 记号，只转一次
- 拖图不走剪贴板，这块管不了：Claude Code 靠 E 盘 `70_钩子\脚本\拖图-vivo截图换成文件.cjs`，Pi 靠 `~\.pi\agent\extensions\vivo-drag.ts`

_2026-10-18 建（待用户过目）_
