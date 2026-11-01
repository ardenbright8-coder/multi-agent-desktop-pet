# vivo —— vivo 截图复制（在 vivo 办公套件点「复制」后，哪都能 Ctrl+V）

**这块管什么**：vivo 截图弹窗点「复制」放进剪贴板的是「一张光秃秃的图」（它的代码是 Electron 的 `clipboard.writeImage`，只有 PNG 和位图）。网页认；Claude Code 在 Windows 上读剪贴板图常失灵；命令窗口 Ctrl+V 只能贴字。这块每 0.3 秒看一眼剪贴板，看到光秃秃一张图，就存成 jpg 到中转夹 `D:\Downloads\vivo办公套件\截图中转\`（只留最新 100 张），再清空重放：这个文件 + 一张图（CF_DIB、PNG）+ 文件位置那行字 + 本块的记号。Claude Code、Pi 拿到图片文件位置会自己打开，这是社区公认最稳的路。只借桌宠程序当入口，不开窗口，只认 `shared`。另管一件小事：开机看 vivo 拖图补丁还在不在。

| 文件 | 管什么 |
|---|---|
| `vivo-clip.ts` | 入口：`initVivoClip` / `closeVivoClip` / `vivoClipStatus`（给「板块与内存」显示）。轮询、认图、存中转夹、补剪贴板、清旧图 |
| `clip-format.ts` | 纯函数：认不认「光秃秃一张图」、中转夹起名和留几张、拼「复制的文件」和「一张图」两种格式。测试 `testkit/tests/vivo-clip-format.test.ts` |
| `win32.ts` | 剪贴板的 Windows 调用（koffi）：看有没有某种格式、一次放几样、换格式编号 |
| `drag-patch.ts` | 开机看一眼 vivo 拖图补丁还在不在（只读程序包目录和弹窗那个小文件找记号）；被升级盖掉就弹系统通知叫他双击重装；这套系统的 vivo 没登记到 F 盘共用那份就弹通知叫他登记。测试 `testkit/tests/vivo-drag-patch.test.ts` |

## 对外露出什么

`initVivoClip  closeVivoClip  vivoClipStatus  VivoClipStatus`（状态里带 `dragPatch`：已装 / 被升级盖掉了 / 没装 vivo / 看不出来）

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
- 🚨 **拖图靠改 vivo 程序包，不靠本块**（2026-10-18 他拍板改、实测拖进 Claude Code 出 `[Image #N]`）：vivo 原版弹窗里只有一张 160 像素宽的预览图（blob 链接），原图在手机上，点「复制」「保存」才下到 `%APPDATA%\pcsuite\data\Notification\`。补丁改 vivo `app.asar` 两处：弹窗一出就后台下原图（约 0.5 秒）、拖图时主程序 `startDrag` 交原图文件、该夹只留最新 10 张。补丁脚本、Claude Code 和 Pi 插件正本、换电脑一键装、体检都在 `app\vivo配套（拖图补丁·插件·一键装）\`，大文件备份在 `D:\Downloads\vivo办公套件\拖图补丁备份\`。本块只管开机看补丁在不在
- 🚨 **看补丁要用 `original-fs`**（2026-10-24）：Electron 里普通 fs 把 `.asar` 当文件夹，`openSync` 报 ENOENT，开机天天记「看 vivo 拖图补丁出错」、状态永远「看不出来」。单测在普通 Node 里没有 original-fs，自动退回 node:fs
- 🚨 **弹窗分块文件名每版不同**（8 月版 `174.js`、7.0.6 版 `184.js`）：`drag-patch.ts` 挨个读 `dist/electron` 下 1MB 以内的小分块找记号，别再写死名字
- 🚨 **两套系统共用 F 盘一份 vivo**（`F:\程序\0072_vivo办公套件`，2026-11-01 起），补丁打一次两边生效。vivo 在哪只认注册表 `HKLM\SOFTWARE\WOW6432Node\pcsuite` 的 `InstPath`（`vivoInstallDir()`，补丁脚本同样），别写死路径。还指着别处的系统，开机弹通知叫他双击那夹的 `在这套系统上登记（vivo指向F盘这份）.cmd`（`needsSharedRegister`）
- 补丁没装上或原图还没下好时拖，交出去的仍是 blob 链接：Claude Code 插件、兜底钩子 `70_钩子\脚本\拖图-vivo截图换成文件.cjs`、Pi 插件删链接、提示「等 1 秒再拖或点复制」。🚨 别拿「夹里最新一张」顶，会拿成上一次的图（2026-10-18 拿错过）
- 🚨 **看门狗（2026-10-24）**：10-24 2:45–3:24 一张没补、日志一句没留，重开才好。`watch()` 每 5 秒看：轮询停没停、剪贴板主人小窗口（`win32.alive()`）还在不在、有没有认出来却没补上的光秃秃的图（`missedSequence`，隔 2 秒重试、最多 3 次）；连着 3 次放不进剪贴板就 `rebuild()` 重开接口。有图但不补（带文件、网页片段、字）记一句为什么，同一句 1 分钟内只记一次（`note`）
- 🚨 **补丁有版本号**：`drag-patch.ts` 的 `MARK` 跟 `打补丁.cjs` 一致（现在 v2：点图复制、弹窗回右下角）。旧记号报「装的是旧版补丁」并弹通知叫他双击重装；改补丁就两边一起升号
- 整套方案、换电脑怎么装、坑：项目里 `vivo截图（复制补图·拖图补丁·换电脑一键装）\`

_2026-10-18 建（待用户过目）_
