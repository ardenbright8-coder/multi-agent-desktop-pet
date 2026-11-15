// 交互弹窗（权限／询问）出现时抢焦点、关闭后还焦点的状态机单测（2026-11-14）。

import assert from "node:assert/strict";
import test from "node:test";
import { PanelFocusTracker, type PetFocusWin32 } from "../../pet/panel-focus";

function createFakeWin32(initialFg: bigint, aliveWindows: bigint[] = [100n, 200n, 300n]) {
  let currentFg = initialFg;
  const alive = new Set<bigint>(aliveWindows);
  const broughtToFront: bigint[] = [];
  const win32: PetFocusWin32 = {
    foreground: () => currentFg,
    isWindow: (hwnd) => hwnd !== 0n && alive.has(hwnd),
    bringToFront: (hwnd) => {
      broughtToFront.push(hwnd);
      if (!alive.has(hwnd)) return false;
      currentFg = hwnd;
      return true;
    },
  };
  return {
    win32,
    broughtToFront,
    setFg: (hwnd: bigint) => { currentFg = hwnd; },
    closeWindow: (hwnd: bigint) => { alive.delete(hwnd); },
  };
}

test("首次弹出交互面板记住原窗口并抢焦点，队列切下一条不覆盖原窗口，关后还焦点", () => {
  const selfHwnd = 100n;
  const editorHwnd = 200n;
  const fake = createFakeWin32(editorHwnd);
  const focusCalls: Array<{ hwnd: bigint; steal: boolean }> = [];
  const tracker = new PanelFocusTracker({
    getWin32: () => fake.win32,
    getSelfHwnd: () => selfHwnd,
    focusPetWindow: (steal) => {
      focusCalls.push({ hwnd: selfHwnd, steal });
      if (steal) fake.setFg(selfHwnd);
    },
  });

  // 弹出第一条权限弹窗：记住 editorHwnd，抢焦点
  tracker.sync(true);
  assert.deepEqual(focusCalls, [{ hwnd: selfHwnd, steal: true }]);

  // 高度微调或队列立即切到第二条（仍为 focusPanel=true）：保持置顶，不覆盖 editorHwnd
  tracker.sync(true);
  assert.deepEqual(focusCalls, [
    { hwnd: selfHwnd, steal: true },
    { hwnd: selfHwnd, steal: false },
  ]);

  // 全部处理完收起弹窗（此时前台仍是桌宠）：把焦点还给最初的 editorHwnd
  tracker.sync(false);
  assert.deepEqual(fake.broughtToFront, [selfHwnd, editorHwnd]);

  // 再次收到关闭通知：不重复切窗
  tracker.sync(false);
  assert.deepEqual(fake.broughtToFront, [selfHwnd, editorHwnd]);
});

test("用户手动切去别的窗口后再收起弹窗，绝不强行抢回原窗口", () => {
  const selfHwnd = 100n;
  const editorHwnd = 200n;
  const browserHwnd = 300n;
  const fake = createFakeWin32(editorHwnd);
  const tracker = new PanelFocusTracker({
    getWin32: () => fake.win32,
    getSelfHwnd: () => selfHwnd,
    focusPetWindow: (steal) => { if (steal) fake.setFg(selfHwnd); },
  });

  tracker.sync(true);
  // 弹窗开着期间用户自己点进了浏览器
  fake.setFg(browserHwnd);
  tracker.sync(false);

  assert.deepEqual(fake.broughtToFront, [selfHwnd]);
  assert.equal(fake.win32.foreground(), browserHwnd);
});

test("点击返回终端（markSkipRestore）后收起面板，不还给弹窗前那个旧窗口", () => {
  const selfHwnd = 100n;
  const browserHwnd = 300n;
  const fake = createFakeWin32(browserHwnd);
  const tracker = new PanelFocusTracker({
    getWin32: () => fake.win32,
    getSelfHwnd: () => selfHwnd,
    focusPetWindow: (steal) => { if (steal) fake.setFg(selfHwnd); },
  });

  tracker.sync(true);
  tracker.markSkipRestore();
  tracker.sync(false);

  assert.deepEqual(fake.broughtToFront, [selfHwnd]);
});

test("原窗口已是桌宠自己或已关闭、或 Win32 降级为空时，安全跳过还焦点不报错", () => {
  const selfHwnd = 100n;
  const closedHwnd = 200n;

  // 情况一：弹窗前桌宠自己就在前台
  const selfFake = createFakeWin32(selfHwnd);
  const selfTracker = new PanelFocusTracker({
    getWin32: () => selfFake.win32,
    getSelfHwnd: () => selfHwnd,
    focusPetWindow: () => {},
  });
  selfTracker.sync(true);
  selfTracker.sync(false);
  assert.deepEqual(selfFake.broughtToFront, []);

  // 情况二：原窗口中途关掉了
  const goneFake = createFakeWin32(closedHwnd);
  const goneTracker = new PanelFocusTracker({
    getWin32: () => goneFake.win32,
    getSelfHwnd: () => selfHwnd,
    focusPetWindow: (steal) => { if (steal) goneFake.setFg(selfHwnd); },
  });
  goneTracker.sync(true);
  goneFake.closeWindow(closedHwnd);
  goneTracker.sync(false);
  assert.deepEqual(goneFake.broughtToFront, [selfHwnd]);

  // 情况三：Win32 降级 / 隔离环境不切真窗，仍保证 focusPetWindow 被调到且不抛错
  const fallbackCalls: boolean[] = [];
  const fallbackTracker = new PanelFocusTracker({
    getWin32: () => null,
    getSelfHwnd: () => 0n,
    focusPetWindow: (steal) => { fallbackCalls.push(steal); },
  });
  fallbackTracker.sync(true);
  fallbackTracker.sync(false);
  assert.deepEqual(fallbackCalls, [true]);
});
