---
这是啥: Gemini额度独立模块的代码门牌
什么时候用: 改桌宠Gemini采集或提示球前
谁写的: Pi 2026-10-19
人看过没: 没
---
# gemini —— Gemini 用量提示球（待用户过目）

## 这块管什么
只读 Gemini 官网的当前周期额度、重置时间；桌面上每账号一个小提示球。周额度只存数据，不常显。数据不进 Agent 事件索引。

## 对外露出什么
`gemini-quota.ts`：initGeminiQuota / closeGeminiQuota / toggleGeminiQuota / geminiQuotaStatus。app.ts 注入桌宠位置，不反向认识 pet。

## 依赖谁
只认 shared 和 Node/Electron。model、receiver 可在纯 Node 下测试；renderer 不接触 Node。

## 改之前先知道
- 采集器只读官方 /usage 卡片，不调用私有额度接口，不复制登录凭据，不自动聊天。
- 本机收件器只绑127.0.0.1，随机选端口后记住；占用则停，不连错服务。它不是桌宠 Agent 主链路，主链路仍是原随机命名管道。
- 收件凭据仅准更新本块读数，放 appData，不进源码/Git，不打印。安装脚本按每次随机安装地址提供。
- 提示球 showInactive、不可聚焦、全窗鼠标穿透；不抓用户鼠标。关 Gemini 来源后最多3分钟隐藏，旧数不冒充实时。
- 裸时分照官网显示，不猜时区、日期，不到点自动清零。

## 专题
先验 model/receiver，再用公共 Playwright Electron 驱动验真窗口；测试隔离数据，不清日常dist。
