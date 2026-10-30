// 仅给本小样窗口加Windows原生材质；不改系统设置、不抓取桌面、不引入新依赖。
const os = require("node:os");
function ellipseRegion(size, radius) {
  const c = size / 2, rows = [];
  for (let y = Math.floor(c - radius); y < Math.ceil(c + radius); y++) {
    const half = Math.sqrt(Math.max(0, radius * radius - (y + .5 - c) ** 2));
    const x = Math.floor(c - half), right = Math.ceil(c + half);
    if (right > x) rows.push({ x, y, width: right - x, height: 1 });
  }
  return rows;
}
function roundedRegion(width, height, radius = 14) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const dy = y < radius ? radius - y - .5 : y >= height - radius ? y + .5 - (height - radius) : 0;
    const inset = dy ? Math.max(0, radius - Math.sqrt(radius * radius - dy * dy)) : 0;
    const x = Math.floor(inset);
    rows.push({ x, y, width: width - x * 2, height: 1 });
  }
  return rows;
}
let sendMessage, getAsyncKeyState, getFgWin, getWinPid, openProc, queryProcName, closeH, findWin, findWinEx, isWinVis, isWinIconic, getWinTextLen, getWinText;
function keepLit(win) {
  if (!win.__glassNative || win.isDestroyed()) return;
  try {
    if (!sendMessage) sendMessage = require("koffi").load("user32.dll").func("intptr_t __stdcall SendMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)");
    const handle = win.getNativeWindowHandle(), hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    // 只更新本窗非客户区的外观状态，不激活窗口，也不改变前台。
    sendMessage(hwnd, 0x0086, 1n, 0n);
  } catch (error) { console.warn("本小样的失焦玻璃外观未更新：" + error.message); }
}
function isMouseDown() {
  if (os.platform() !== "win32") return { left: false, right: false };
  try {
    if (!getAsyncKeyState) getAsyncKeyState = require("koffi").load("user32.dll").func("short __stdcall GetAsyncKeyState(int vKey)");
    return { left: (getAsyncKeyState(0x01) & 0x8000) !== 0, right: (getAsyncKeyState(0x02) & 0x8000) !== 0 };
  } catch { return { left: false, right: false }; }
}
function ensureWinFuncs() {
  if (getFgWin) return;
  const koffi = require("koffi"), u32 = koffi.load("user32.dll"), k32 = koffi.load("kernel32.dll");
  getFgWin = u32.func("uintptr_t __stdcall GetForegroundWindow()");
  findWin = u32.func("uintptr_t __stdcall FindWindowW(const char16_t *cls, const char16_t *title)");
  findWinEx = u32.func("uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const char16_t *cls, const char16_t *title)");
  isWinVis = u32.func("int __stdcall IsWindowVisible(uintptr_t hwnd)");
  isWinIconic = u32.func("int __stdcall IsIconic(uintptr_t hwnd)");
  getWinTextLen = u32.func("int __stdcall GetWindowTextLengthW(uintptr_t hwnd)");
  getWinText = u32.func("int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *buf, int maxCount)");
  getWinPid = u32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)");
  openProc = k32.func("uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  queryProcName = k32.func("int __stdcall QueryFullProcessImageNameW(uintptr_t hProc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)");
  closeH = k32.func("int __stdcall CloseHandle(uintptr_t h)");
}
function getHwndTitle(hwnd) {
  if (!hwnd) return "";
  const len = getWinTextLen(hwnd);
  if (len <= 0) return "";
  const buf = new Uint16Array(Math.min(len + 2, 512));
  const actual = getWinText(hwnd, buf, buf.length);
  if (actual <= 0) return "";
  return Buffer.from(buf.buffer, 0, actual * 2).toString("utf16le");
}
function getHwndExe(hwnd) {
  if (!hwnd) return "";
  const pid = [0]; getWinPid(hwnd, pid); if (!pid[0]) return "";
  const h = openProc(0x1000, 0, pid[0]); if (!h) return "";
  const buf = new Uint16Array(512), sz = [512];
  const ok = queryProcName(h, 0, buf, sz); closeH(h);
  if (!ok) return "";
  return Buffer.from(buf.buffer, 0, sz[0] * 2).toString("utf16le");
}
function isHwndGeminiExe(hwnd) {
  return /[\\/]Gemini\.exe$/i.test(getHwndExe(hwnd));
}
function isAnyBrowserWindowOpen() {
  if (os.platform() !== "win32") return true;
  try {
    ensureWinFuncs();
    let hwnd = 0, guard = 0;
    while ((hwnd = findWinEx(0, hwnd, null, null)) && guard++ < 3000) {
      if (!isWinVis(hwnd) || isWinIconic(hwnd)) continue;
      const title = getHwndTitle(hwnd);
      if (!title || !/gemini/i.test(title)) continue;
      const exe = getHwndExe(hwnd);
      if (/[\\/](Tabbit Browser|chrome|msedge|brave|firefox|arc|BrowserOS|vivaldi|opera)\.exe$/i.test(exe)) return true;
    }
    return false;
  } catch { return true; }
}
function isGeminiAppOpen() {
  if (os.platform() !== "win32") return false;
  try {
    ensureWinFuncs();
    const hwnd = findWin(null, "Gemini");
    if (!hwnd || !isWinVis(hwnd) || isWinIconic(hwnd)) return false;
    return isHwndGeminiExe(hwnd);
  } catch { return false; }
}
function isGeminiAppForeground() {
  if (os.platform() !== "win32") return false;
  try {
    ensureWinFuncs();
    const hwnd = getFgWin();
    if (!hwnd || !isWinVis(hwnd)) return false;
    return isHwndGeminiExe(hwnd);
  } catch { return false; }
}
function createGlassWindow(electron, options) {
  // 使用 Chromium 原生每像素透明通道渲染苹果液态玻璃高光与抗锯齿圆缘，避免 Win32 SetWindowRgn 锯齿灰边与 Acrylic 灰底方框。
  const win = new electron.BrowserWindow({ ...options, transparent: true });
  win.__glassNative = false;
  return win;
}
function orbShape(win, radius) { if (win.__glassNative && !win.isDestroyed()) win.setShape(ellipseRegion(66, radius)); }
function panelShape(win) { if (win.__glassNative && !win.isDestroyed()) { const b = win.getBounds(); win.setShape(roundedRegion(b.width, b.height)); } }
module.exports = { createGlassWindow, keepLit, isMouseDown, isAnyBrowserWindowOpen, isGeminiAppOpen, isGeminiAppForeground, orbShape, panelShape, ellipseRegion, roundedRegion };
