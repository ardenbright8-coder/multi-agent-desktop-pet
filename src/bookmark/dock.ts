// 看板贴屏几何与 Win32 沉底常量：纯函数零依赖，方便单测。
// 「总在其他窗口之下」的实测语义（2026-09-10 用户拍板）：压在桌面之上、被任何别的窗口盖住，
// 绝不挡人；用户正在面板里交互（聚焦）期间不压底，失焦才压。

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 贴主屏右缘：宽 = 工作区宽 ÷ 3（至少 320，防窄屏挤死），高 = 工作区全高（顶到底）。 */
export function computeDockedBounds(workArea: Rect): Rect {
  const width = Math.max(320, Math.round(workArea.width / 3));
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
  };
}

/** Win32：HWND_BOTTOM = 压到 Z 序最底；SWP 组合 = 不动位置尺寸、不抢激活。 */
export const HWND_BOTTOM = 1;
export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SINK_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;
