// 命令行上带哪个自测开关。只算 boolean，不做任何副作用——
// 设临时目录、关硬件加速那些副作用留在 app.ts 顶部，顺序有讲究，别搬进来。

export const smokeMode = process.argv.includes("--smoke-test");
export const screenshotMode = process.argv.includes("--screenshot-test");
export const lifecycleMode = process.argv.includes("--lifecycle-test");
export const singleInstanceHostMode = process.argv.includes("--single-instance-host-test");
export const controlsMode = process.argv.includes("--controls-test");
export const testMode = smokeMode || screenshotMode || lifecycleMode || singleInstanceHostMode || controlsMode;

export function testModeName(): string {
  return smokeMode ? "smoke"
    : screenshotMode ? "screenshot"
    : lifecycleMode ? "lifecycle"
    : singleInstanceHostMode ? "single-instance"
    : "controls";
}
