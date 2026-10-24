// Agent命令快捷窗口的纯函数：按钮名单从哪来、输入框那条线在哪、窗口摆哪、哪个程序算终端。不碰 Electron、不碰 Win32，单测直接测。

/** 一个按钮：显示的字 + 点了要替用户按的那个键（终端里绑着「往输入框打字」）。 */
export interface QuickButton {
  /** 终端设置里这个按钮的 id（User.CC.xxx）：记顺序用它，改了按钮上的字顺序也不乱。 */
  id: string;
  label: string;
  /** 终端里给它绑的键，f13～f24。 */
  key: string;
  /** 对应的虚拟键码（F13＝0x7C，往后依次加一）。 */
  vk: number;
  /** 「打开文件」按钮要打开的文件（终端里打的是 `! explorer "路径"`）；普通按钮是 null。 */
  openPath: string | null;
}

const VK_F13 = 0x7c;

/**
 * 按钮打的字是 `! explorer "路径"`（回车可有可无）→ 这是个「打开文件」按钮，返回路径；别的返回 null。
 * 2026-10-17：替用户按键打这行字，输入框里原本有字就会接在后面一起发出去，所以窗口认出来自己开，不往终端打字。
 */
export function openPathOf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = /^!\s*explorer\s+"([^"]+)"\s*$/.exec(input);
  return match ? match[1] : null;
}

/**
 * E 盘搬过家的夹：旧前缀 → 新前缀。按钮名单在各自系统的终端设置里，哪套没重跑「加命令按钮.py」就还指着旧地址，
 * 点「使用说明」报找不到（2026-10-23 夹从 20_环境运维配置 搬进 60_公用资源\Claude Code装备）。这里兜一下，两套都能开。
 */
const MOVED_FOLDERS: [string, string][] = [
  [
    "E:\\个人AI资源管理\\20_环境运维配置（管这台机·服务器·软件设置）\\Claude Code（配置与手感调优）\\",
    "E:\\个人AI资源管理\\60_公用资源（钩子·skill·搜索引擎·可后期扩展）\\Claude Code装备（键位·状态栏·外观·权限·两套共用）\\",
  ],
];

/** 按钮指的文件不在了、又是搬过家的夹，就换成新地址（新地址也没有就原样还回去，让报错照旧说旧地址）。 */
export function resolveMovedPath(path: string, exists: (p: string) => boolean): string {
  if (exists(path)) return path;
  for (const [from, to] of MOVED_FOLDERS) {
    if (!path.startsWith(from)) continue;
    const moved = to + path.slice(from.length);
    if (exists(moved)) return moved;
  }
  return path;
}

/** 键名 f13～f24 → 虚拟键码；别的键一律不认（只认这一段，真键盘上没有，不会跟谁撞）。 */
export function vkForKey(key: string): number | null {
  const match = /^f(1[3-9]|2[0-4])$/.exec(key.trim().toLowerCase());
  return match ? VK_F13 + Number(match[1]) - 13 : null;
}

/** Windows 终端的设置文件允许写注释。去掉 // 和 /* *\/ 注释（字符串里的不动），再交给 JSON.parse。 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 从终端设置里读按钮名单（唯一一份，终端那个 Ctrl+Q 备胎弹框用的也是它）：
 * id 以 User.CC. 开头、动作是「往输入框打字」、并且绑了 f13～f24 的，按设置文件里的先后排。
 * 设置文件读坏了返回空数组，窗口就不弹，不炸。
 */
export function parseTerminalButtons(settingsText: string): QuickButton[] {
  let settings: unknown;
  try {
    settings = JSON.parse(stripJsonComments(settingsText));
  } catch {
    return [];
  }
  if (!settings || typeof settings !== "object") return [];
  const { actions, keybindings } = settings as { actions?: unknown; keybindings?: unknown };
  if (!Array.isArray(actions) || !Array.isArray(keybindings)) return [];
  const keyOf = new Map<string, string>();
  for (const binding of keybindings) {
    if (binding && typeof binding.id === "string" && typeof binding.keys === "string") keyOf.set(binding.id, binding.keys);
  }
  const buttons: QuickButton[] = [];
  for (const action of actions) {
    if (!action || typeof action.id !== "string" || !action.id.startsWith("User.CC.")) continue;
    if (action.command?.action !== "sendInput" || typeof action.name !== "string") continue;
    const key = keyOf.get(action.id);
    const vk = key ? vkForKey(key) : null;
    if (key && vk !== null) buttons.push({ id: action.id, label: action.name, key, vk, openPath: openPathOf(action.command.input) });
  }
  return buttons;
}

/**
 * 按用户拖出来的顺序排（功能跟着按钮走）。
 * 存的是 id 列表；存档里没有的按钮（新加的）排在最后，存档里有但终端里已经删了的直接忽略。
 */
export function applyOrder(buttons: QuickButton[], savedIds: readonly string[]): QuickButton[] {
  const rank = new Map(savedIds.map((id, index) => [id, index]));
  return buttons
    .map((button, index) => ({ button, key: rank.get(button.id) ?? savedIds.length + index }))
    .sort((a, b) => a.key - b.key)
    .map((item) => item.button);
}

/**
 * 把第 from 个拿出来插到第 to 个的位置，中间的依次让一格，返回新数组；序号不对就原样返回。
 * 2026-10-17 从「交换」改成「插入」：交换要正好松在另一个按钮上，拖到最上面、缝里都落不下（用户嫌不丝滑）。
 */
export function moveButton<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  if (from === to || !(from in next) || !(to in next)) return next;
  const [moving] = next.splice(from, 1);
  next.splice(to, 0, moving);
  return next;
}

/** 顺序存档 → id 列表；坏档、不是字符串数组一律当没存过。 */
export function parseOrder(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

/** 程序完整路径 → 是不是 Windows 终端。 */
export function isTerminalProcess(path: string): boolean {
  return path.split(/[\\/]/).pop()?.toLowerCase() === "windowsterminal.exe";
}

export interface Rect { x: number; y: number; width: number; height: number }

/** 截图的一块像素：每个点 4 个字节，蓝、绿、红、透明（Electron 截图给的就是这个顺序）。 */
export interface Bitmap { data: Uint8Array; width: number; height: number }

function lumAt(image: Bitmap, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return (image.data[i + 2] * 299 + image.data[i + 1] * 587 + image.data[i] * 114) / 1000;
}

/**
 * 在终端截图里找 Claude 输入框上面那条横线（2026-10-12：按字号估算差了好几行，改成直接量）。
 * 只看左半边（右边会被窗口自己挡住），从下往上扫：一整行几乎全是同一种跟底色明显不同的颜色、而且很细，就是一条横线。
 * 从下往上数，第一条是输入框下面那条，第二条就是上面那条。找不到两条（比如正弹着别的对话框）返回 null。
 * 返回的 y 是这条线最上面那一排像素，在截图里的位置。
 */
export function findInputTopLine(image: Bitmap): number | null {
  const x0 = Math.floor(image.width * 0.08);
  const x1 = Math.floor(image.width * 0.45);
  const samples = Math.max(1, x1 - x0);
  // 底色：这块里最常见的亮度（浅色、深色主题都认）。
  const histogram = new Array<number>(256).fill(0);
  for (let y = Math.floor(image.height * 0.3); y < image.height; y += 3) {
    for (let x = x0; x < x1; x += 7) histogram[Math.round(lumAt(image, x, y))] += 1;
  }
  const background = histogram.indexOf(Math.max(...histogram));
  const offShare = (y: number): number => {
    let hits = 0;
    for (let x = x0; x < x1; x += 1) if (Math.abs(lumAt(image, x, y) - background) > 35) hits += 1;
    return hits / samples;
  };
  const isLineRow = (y: number): boolean => offShare(y) > 0.92;
  // 线的上下几排得是正常底色：贴着窗口边的那圈边框（2026-10-12 实机踩过，被当成了一条线）不算。
  const isOpenRow = (y: number): boolean => y >= 0 && y < image.height && offShare(y) < 0.5;
  const lines: number[] = [];
  let y = image.height - 1;
  const top = Math.floor(image.height * 0.2);
  while (y >= top && lines.length < 2) {
    if (!isLineRow(y)) {
      y -= 1;
      continue;
    }
    let start = y;
    while (start - 1 >= top && isLineRow(start - 1)) start -= 1;
    const thin = y - start + 1 <= 8; // 太厚的不是线（整块色带）
    if (thin && isOpenRow(start - 3) && isOpenRow(y + 3)) lines.push(start);
    y = start - 1;
  }
  return lines.length === 2 ? lines[1] : null;
}

/** 窗口长相的几个尺寸（跟 renderer/quickcmd.css 对上，改一边要改另一边）。 */
export const PANEL = {
  width: 166,
  padTop: 7,
  head: 21,
  button: 25,
  gap: 5,
  padBottom: 6,
};

export function panelHeight(count: number): number {
  return PANEL.padTop + PANEL.head + count * PANEL.button + Math.max(0, count - 1) * PANEL.gap + PANEL.padBottom;
}

/**
 * 窗口摆哪（2026-10-12 用户拍板）：右边贴着终端窗口右边，底边刚好在 Claude 输入框上面那条横线上。
 * 终端拖多大、挪哪儿都跟着。lineY＝那条线的位置（跟 terminal 同一套坐标），量不到就放在终端底部往上 1/6 处。
 * 终端太矮放不下就顶到终端最上面，不出终端。
 */
export function computePanelBounds(terminal: Rect, count: number, lineY: number | null): Rect {
  return anchorAboveInput(terminal, lineY, PANEL.width, panelHeight(count));
}

/** 说明面板（点「打开文件」按钮弹出的那块玻璃）的尺寸。 */
export const SHEET = { width: 340, height: 470 };

/** 说明面板摆哪：跟按钮那列同一个位置（贴终端右边、底边在输入框那条线上），只是更大；终端太矮就压到终端那么高。 */
export function computeSheetBounds(terminal: Rect, lineY: number | null): Rect {
  return anchorAboveInput(terminal, lineY, SHEET.width, Math.min(SHEET.height, Math.max(200, terminal.height - 20)));
}

function anchorAboveInput(terminal: Rect, lineY: number | null, width: number, height: number): Rect {
  const inset = 10; // 别压在终端右边的滚动条上
  const x = terminal.x + terminal.width - width - inset;
  const bottom = lineY !== null ? lineY - 3 : terminal.y + terminal.height * (5 / 6);
  const y = Math.max(terminal.y, bottom - height);
  return { x: Math.round(x), y: Math.round(y), width, height: Math.round(height) };
}
