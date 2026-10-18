# vivo —— vivo 截图复制（在 vivo 办公套件点「复制」后，哪都能 Ctrl+V）

**这块管什么**：vivo 点「复制」往剪贴板放的是「复制了一个文件」（图存在 `%APPDATA%\vivoClipdata\`，vivo 写死的），网页认、命令窗口和很多程序不认。这块每 0.3 秒看一眼剪贴板，看到是 vivo 那个夹里的一张图，就清空重放：原来的文件 + 一张真图（CF_DIB 和 PNG）+ 一行图片路径 + 本块的记号格式。只借桌宠程序当入口，不开窗口，只认 `shared`。

| 文件 | 管什么 |
|---|---|
| `vivo-clip.ts` | 入口：`initVivoClip` / `closeVivoClip` / `vivoClipStatus`（给「板块与内存」显示）。轮询、判断、补图 |
| `clip-format.ts` | 纯函数：认不认 vivo 的图、拼「复制的文件」和「一张图」两种格式。测试 `testkit/tests/vivo-clip-format.test.ts` |
| `win32.ts` | 剪贴板的 Windows 调用（koffi）：读文件列表、一次放几样、换格式编号 |

## 对外露出什么

`initVivoClip  closeVivoClip  vivoClipStatus  VivoClipStatus`

## 依赖谁

只认 `shared`（日志）。app.ts 装配时调，自测模式不起（别动真机剪贴板）。

## 改之前先知道

- 🚨 **不能用 Electron 自带的 clipboard 写**：它一写先清空，放不回「复制了一个文件」，网页就贴不上了。所以全走 koffi 自己放
- 🚨 **放东西得有主人窗口**：`win32.ts` 开了一个看不见的只收消息的小窗口（HWND_MESSAGE）当主人，不开 Windows 文档说 SetClipboardData 会失败
- 防自己转自己：补完放一个 `AgentPetVivoClip` 记号格式，下次看到记号跳过；补完顺手记下新的剪贴板序号
- 只认「恰好一个文件、在 vivo 夹里、是图片」。文件夹里复制普通文件、复制好几个，原样不碰
- 像素用 24 位、从下往上排：32 位图的透明位各程序各认各的，有的会贴出全透明的图
- 补的那行路径是给命令窗口 Ctrl+V 用的。网页要是因此多贴出一行字，把 `vivo-clip.ts` 的 `PUT_PATH_TEXT` 改 false
- vivo 复制是两步：先清空，约 1 秒后才放文件；PasteBar、SyncClipboard、vivo 自己都在盯剪贴板，补一次它们都会多看到一次
- 实测（2026-10-18）：模拟 vivo 复制一张 2607×1080 截图，补完剪贴板里有 文件 / 图 / PNG / 路径字 / 记号，只补一次不打转
- 拖图不走剪贴板，这块管不了：Claude Code 靠 E 盘 `70_钩子\脚本\拖图-vivo截图换成文件.cjs`，Pi 靠 `~\.pi\agent\extensions\vivo-drag.ts`

_2026-10-18 建（待用户过目）_
