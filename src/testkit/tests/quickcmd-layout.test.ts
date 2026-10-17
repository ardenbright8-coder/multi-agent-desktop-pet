import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOrder,
  computePanelBounds,
  computeSheetBounds,
  SHEET,
  parseOrder,
  moveButton,
  openPathOf,
  findInputTopLine,
  isTerminalProcess,
  panelHeight,
  parseTerminalButtons,
  PANEL,
  stripJsonComments,
  vkForKey,
  type Bitmap,
} from "../../quickcmd/layout";

// 照 加命令按钮.py 写出来的终端设置样子造一份（顺序、F13～F17、Ctrl+Q 弹框那条）。
const settings = JSON.stringify({
  actions: [
    { command: { action: "sendInput", input: "/compact" }, id: "User.CC.compact", name: "压缩上下文" },
    { command: { action: "sendInput", input: "/effort" }, id: "User.CC.effort", name: "调整 Claude 想多深" },
    { command: { action: "sendInput", input: "帮我出点子：" }, id: "User.CC.idea", name: "帮我出点子" },
    { command: { action: "showSuggestions", source: "tasks" }, id: "User.CC.menu", name: "Claude 常用命令（Ctrl+Q）" },
    { command: { action: "sendInput", input: "x" }, id: "User.Other.thing", name: "别人的按钮" },
    { command: { action: "sendInput", input: "/fast" }, id: "User.CC.fast", name: "开关快速模式（开/关）" },
  ],
  keybindings: [
    { id: "User.CC.compact", keys: "f13" },
    { id: "User.CC.effort", keys: "f14" },
    { id: "User.CC.idea", keys: "f15" },
    { id: "User.CC.menu", keys: "ctrl+q" },
    { id: "User.Other.thing", keys: "f20" },
  ],
  profiles: { defaults: { font: { size: 23 } } },
});

test("按钮名单：只要 User.CC. 开头、往输入框打字、绑了 F13～F24 的，按设置里的先后排", () => {
  const buttons = parseTerminalButtons(settings);
  assert.deepEqual(buttons.map((b) => b.label), ["压缩上下文", "调整 Claude 想多深", "帮我出点子"]);
  assert.deepEqual(buttons.map((b) => b.vk), [0x7c, 0x7d, 0x7e]);
});

test("按钮名单：没绑键的（快速模式）、弹框那条、别人的按钮都不进", () => {
  const labels = parseTerminalButtons(settings).map((b) => b.label);
  assert.ok(!labels.includes("开关快速模式（开/关）"));
  assert.ok(!labels.includes("Claude 常用命令（Ctrl+Q）"));
  assert.ok(!labels.includes("别人的按钮"));
});

test("拖过的顺序：按存档排，存档里没有的新按钮排最后，终端里删了的忽略", () => {
  const buttons = parseTerminalButtons(settings);
  const ordered = applyOrder(buttons, ["User.CC.idea", "User.CC.gone", "User.CC.compact"]);
  assert.deepEqual(ordered.map((b) => b.label), ["帮我出点子", "压缩上下文", "调整 Claude 想多深"]);
  assert.deepEqual(applyOrder(buttons, []).map((b) => b.id), buttons.map((b) => b.id));
});

test("插入：最后一个拖到最上面，其余依次往下让一格；功能（键）跟着按钮走", () => {
  const buttons = parseTerminalButtons(settings);
  const moved = moveButton(buttons, 2, 0);
  assert.deepEqual(moved.map((b) => b.label), ["帮我出点子", "压缩上下文", "调整 Claude 想多深"]);
  assert.equal(moved[0].key, "f15");
  assert.equal(moved[1].key, "f13");
  assert.deepEqual(buttons.map((b) => b.label)[0], "压缩上下文", "原数组不被改动");
});

test("插入：第一个拖到中间、拖到最下面都能落；序号不对就原样", () => {
  const list = ["a", "b", "c", "d", "e"];
  assert.deepEqual(moveButton(list, 0, 2), ["b", "c", "a", "d", "e"]);
  assert.deepEqual(moveButton(list, 1, 4), ["a", "c", "d", "e", "b"]);
  assert.deepEqual(moveButton(list, 3, 3), list);
  assert.deepEqual(moveButton(list, 0, 9), list);
});

test("打开文件按钮：认出 ! explorer \"路径\"，回车可有可无；普通按钮是 null", () => {
  const path = "E:\\个人AI资源管理\\12_使用说明（Ctrl+Q点开·看不懂就来这）\\Claude Code 各种文件放哪.html";
  assert.equal(openPathOf(`! explorer "${path}"\r`), path);
  assert.equal(openPathOf(`! explorer "${path}"`), path);
  assert.equal(openPathOf("/compact"), null);
  assert.equal(openPathOf("帮我出点子：! explorer \"x\""), null, "不在开头的不算");
  assert.equal(openPathOf(undefined), null);
  const withOpen = JSON.parse(settings);
  withOpen.actions.push({ command: { action: "sendInput", input: `! explorer "${path}"\r` }, id: "User.CC.guide", name: "使用说明" });
  withOpen.keybindings.push({ id: "User.CC.guide", keys: "f19" });
  const buttons = parseTerminalButtons(JSON.stringify(withOpen));
  assert.equal(buttons.find((b) => b.id === "User.CC.guide")?.openPath, path);
  assert.equal(buttons[0].openPath, null);
});

test("顺序存档读坏了当没存过", () => {
  assert.deepEqual(parseOrder('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseOrder("坏的"), []);
  assert.deepEqual(parseOrder('[1,2]'), []);
  assert.deepEqual(parseOrder("{}"), []);
});

test("设置文件读坏了：返回空名单，不炸", () => {
  assert.deepEqual(parseTerminalButtons("不是 JSON"), []);
  assert.deepEqual(parseTerminalButtons("{}"), []);
  assert.deepEqual(parseTerminalButtons("null"), []);
});

test("终端设置里带注释也能读（终端允许写注释）", () => {
  const withComments = `// 开头一行注释\n{\n  /* 块注释 */\n  "actions": [{ "command": { "action": "sendInput", "input": "a//b" }, "id": "User.CC.x", "name": "带//的字" }],\n  "keybindings": [{ "id": "User.CC.x", "keys": "f13" }] // 行尾注释\n}`;
  const buttons = parseTerminalButtons(withComments);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].label, "带//的字");
  assert.ok(stripJsonComments('"http://x"').includes("http://x"), "字符串里的 // 不能当注释删");
});

test("键名换键码：只认 f13～f24，别的一律不认", () => {
  assert.equal(vkForKey("f13"), 0x7c);
  assert.equal(vkForKey("F24"), 0x87);
  assert.equal(vkForKey("f12"), null);
  assert.equal(vkForKey("f25"), null);
  assert.equal(vkForKey("ctrl+f13"), null);
});

test("认终端：只认 WindowsTerminal.exe，大小写、正反斜杠都行", () => {
  assert.ok(isTerminalProcess("C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.0\\WindowsTerminal.exe"));
  assert.ok(isTerminalProcess("c:/x/windowsterminal.exe"));
  assert.ok(!isTerminalProcess("C:\\Windows\\explorer.exe"));
  assert.ok(!isTerminalProcess(""));
});

test("窗口高度跟按钮个数走，跟 CSS 的几个尺寸对得上", () => {
  assert.equal(panelHeight(5), 7 + 21 + 5 * 25 + 4 * 5 + 6);
  assert.equal(panelHeight(1), 7 + 21 + 25 + 6);
});

test("摆放：右边贴终端右边（留 10 像素让开滚动条），底边在那条线上面 3 像素", () => {
  const terminal = { x: 100, y: 50, width: 1400, height: 900 };
  const bounds = computePanelBounds(terminal, 5, 700);
  assert.equal(bounds.x + bounds.width, 100 + 1400 - 10);
  assert.equal(bounds.width, PANEL.width);
  assert.equal(bounds.y + bounds.height, 700 - 3);
});

test("摆放：终端挪位置，窗口横着跟过去；底边永远跟着那条线", () => {
  const a = computePanelBounds({ x: 0, y: 0, width: 1000, height: 800 }, 5, 600);
  const b = computePanelBounds({ x: 300, y: 200, width: 1200, height: 900 }, 5, 900);
  assert.equal(b.x - a.x, 300 + 200);
  assert.equal(b.y - a.y, 300);
});

test("摆放：量不到那条线，放在终端从上往下 5/6 处", () => {
  const bounds = computePanelBounds({ x: 0, y: 0, width: 1200, height: 600 }, 5, null);
  assert.equal(bounds.y + bounds.height, 500);
});

test("摆放：终端太矮放不下，顶到终端最上面，不跑出终端", () => {
  const bounds = computePanelBounds({ x: 0, y: 500, width: 800, height: 200 }, 5, 650);
  assert.equal(bounds.y, 500);
});

test("说明面板：跟按钮那列同一个右边、底边在那条线上；终端矮就压低，不出终端", () => {
  const terminal = { x: 100, y: 50, width: 1200, height: 900 };
  const sheet = computeSheetBounds(terminal, 800);
  const panel = computePanelBounds(terminal, 7, 800);
  assert.equal(sheet.x + sheet.width, panel.x + panel.width);
  assert.equal(sheet.y + sheet.height, 800 - 3);
  assert.deepEqual([sheet.width, sheet.height], [SHEET.width, SHEET.height]);
  const short = computeSheetBounds({ x: 0, y: 0, width: 800, height: 300 }, 280);
  assert.equal(short.height, 280);
  assert.ok(short.y >= 0);
});

// 造一张假终端截图：浅绿底，几行零散的字，底部两条 2 像素粗的灰横线（输入框上下两条）。
function fakeTerminal(lines: number[], options: { dark?: boolean; border?: boolean } = {}): Bitmap {
  const width = 400;
  const height = 300;
  const data = new Uint8Array(width * height * 4);
  const bg = options.dark ? [30, 30, 30] : [227, 248, 227];
  const ink = options.dark ? [220, 220, 220] : [40, 40, 40];
  const line = [128, 128, 128];
  const put = (x: number, y: number, rgb: number[]) => {
    const i = (y * width + x) * 4;
    data[i] = rgb[2];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[0];
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, bg);
  // 字：一行里一段一段的，不连成整行
  for (const row of [40, 80, 120, 230, 270]) for (let y = row; y < row + 12; y += 1) for (let x = 0; x < width; x += 1) if (x % 9 < 5) put(x, y, ink);
  for (const top of lines) for (let y = top; y < top + 2; y += 1) for (let x = 0; x < width; x += 1) put(x, y, line);
  // 窗口最底下贴边的一圈深绿边框（实机截图里就有）
  if (options.border) for (let y = height - 3; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, [40, 140, 70]);
  return { data, width, height };
}

test("找线：从下往上第二条就是输入框上面那条", () => {
  assert.equal(findInputTopLine(fakeTerminal([180, 255])), 180);
});

test("找线：输入框里打了好几行字变高了，照样找到上面那条", () => {
  assert.equal(findInputTopLine(fakeTerminal([140, 255])), 140);
});

test("找线：窗口最底下贴边的边框不算线（2026-10-12 实机踩过）", () => {
  assert.equal(findInputTopLine(fakeTerminal([180, 255], { border: true })), 180);
});

test("找线：深色主题也认", () => {
  assert.equal(findInputTopLine(fakeTerminal([180, 255], { dark: true })), 180);
});

test("找线：只有一条线、或者一条都没有，返回 null（窗口用估的位置）", () => {
  assert.equal(findInputTopLine(fakeTerminal([255])), null);
  assert.equal(findInputTopLine(fakeTerminal([])), null);
});
