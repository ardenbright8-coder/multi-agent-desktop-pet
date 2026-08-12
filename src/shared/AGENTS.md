# shared —— 底座

**这块管什么**：事件协议（字段定义、规范化、脱敏）、所有路径常量、原子写文件。

| 文件 | 管什么 |
|---|---|
| `protocol.ts` | `AgentEvent` 等全部类型 + `normalizeAgentEvent`（外来事件一律先过它）+ 协议版本号 |
| `paths.ts` | `appDataRoot` `discoveryPath` `eventJournalPath` `preferencesPath` |
| `atomic-file.ts` | `writeJsonAtomic`（先写临时文件再改名，防写一半断电） |

## 对外露出什么

整个文件都是对外的，随便调。

## 依赖谁

**谁都不依赖。** 只用 Node 自带的东西，连 electron 都不 import。

🚨 **进入门槛：三个以上功能块真在用，才准往这儿放。**
只有两块在用的东西，放到用它的那块里去 —— 过早抽出来的"公用"是后期一改就炸的头号来源。

## 改之前先知道

- **改 `protocol.ts` 等于改跟四家 Agent 的约定。** 插件和 Hook 在项目根 `integrations\` 里，是各自独立的文件，不会跟着编译，**改字段必须同步改它们**，否则事件照收但字段丢了还不报错。
- `PROTOCOL_VERSION` 动了要想清楚旧版插件还认不认。
- 脱敏规则（`metadata` 里像密钥的字段）有测试盯着：`testkit\tests\protocol-normalization.test.ts`。

👨‍💻 **这一节里还有你踩过、但我没记全的坑 —— 补在这儿。**
