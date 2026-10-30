---
这是啥: Gemini暗色用量球的局部代码边界
什么时候用: 只改这个用量组件前
谁写的: Pi 2026-10-19
人看过没: 没
---
# 当前用量组件

## 管什么
平时半尺寸、悬停放大、右键详情、左右划切号、长按拖动；目前只用演示数据。

## 对外入口
只从 `main.cjs` 启动；界面通过 `preload.cjs` 的白名单获取快照和发出操作。

## 分块与依赖
- 改显示：`index.html`、`style.css`、`ui.js`；不读文件，不调用系统接口。
- 改手势判断：`interaction.js`；纯函数，由界面绑定实际事件。
- 改窗口材质：`native-glass.cjs`；只处理自己的窗口，不操作系统配置。
- 改位置：`geometry.cjs`；纯几何，不认识主宠。

## 改之前先知道
实际球是25/50，66是包含空白的窗口尺寸。悬停绝不弹详情。左划下一个、右划上一个，按住500ms才允许拖动；划动不移动窗口，拖动不切号。
数字按最新要求用纯白，账号通过对应圆环高亮和右键详情识别。Windows原生背景柔化不是macOS的原生Liquid Glass。

## 验收
先跑 `node verify-boundaries.cjs`，再跑 `node --test interaction.test.cjs`、`node verify.mjs`。测试在公共Playwright中进行，不移动物理鼠标、不清日常dist。
