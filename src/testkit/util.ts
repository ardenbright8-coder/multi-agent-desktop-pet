// 自测公用的小工具：等一会儿、等条件成立、断言渲染层的状态。

import { getPetWindow } from "../pet/window";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return false;
}

export async function assertRenderer(expression: string, message: string): Promise<void> {
  const window = getPetWindow();
  if (!window || window.isDestroyed()) throw new Error(message);
  const passed = await window.webContents.executeJavaScript(`Boolean(${expression})`);
  if (!passed) throw new Error(message);
}
