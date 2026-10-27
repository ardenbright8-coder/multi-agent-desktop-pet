// 书签台渲染层的专属桥。跟桌宠的 channel\preload 互不相干（完全隔离）。

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bookmark", {
  saveImage: (bytes: Uint8Array) => ipcRenderer.invoke("bookmark:image:save", bytes) as Promise<string>,
  readImage: (name: string) => ipcRenderer.invoke("bookmark:image:read", name) as Promise<string>,
  // 图片标注（设定16第三版）：标注单独存，marked 是带编号的那张（给 AI 看）。
  getImageMarks: (name: string) => ipcRenderer.invoke("bookmark:image:marks:get", name),
  setImageMarks: (name: string, marks: unknown, summary: string, marked: Uint8Array | null) =>
    ipcRenderer.invoke("bookmark:image:marks:set", { name, marks, summary, marked }),
  list: () => ipcRenderer.invoke("bookmark:list"),
  dispatch: (input: unknown) => ipcRenderer.invoke('bookmark:dispatch', input),
  boardSkills: () => ipcRenderer.invoke('bookmark:skills:list'),
  readBoardSkill: (name: string) => ipcRenderer.invoke('bookmark:skills:read', name),
  copyDispatch: (id: string, by: string) => ipcRenderer.invoke('bookmark:dispatch:copy', { id, by }),
  add: (input: unknown) => ipcRenderer.invoke("bookmark:add", input),
  insertBeside: (input: unknown) => ipcRenderer.invoke("bookmark:insert-beside", input),
  /** into：捆号＝放进这捆，null＝单独放（从捆里拆出来），不传＝按两边邻居推断（老办法）。 */
  move: (id: string, anchorId: string, place: "above" | "below", into?: string | null) => ipcRenderer.invoke("bookmark:move", { id, anchorId, place, into }),
  remove: (id: string) => ipcRenderer.invoke("bookmark:remove", id),
  removeBundle: (bundleId: string) => ipcRenderer.invoke("bookmark:remove-bundle", bundleId) as Promise<number>,
  /** 跨组一步到位：改派到 assignee（null＝交接单专区／待定）再挪到锚点旁边。 */
  relocate: (id: string, assignee: string | null, anchorId: string | null, place: "above" | "below", into?: string | null) =>
    ipcRenderer.invoke("bookmark:relocate", { id, assignee, anchorId, place, into }),
  /** 整捆搬家：group 不传＝还在原组；传了（null＝交接单专区）就换组。返回搬了几条。 */
  moveBundle: (bundleId: string, anchorId: string | null, place: "above" | "below", group?: string | null) =>
    ipcRenderer.invoke("bookmark:move-bundle", group === undefined ? { bundleId, anchorId, place } : { bundleId, anchorId, place, assignee: group }) as Promise<number>,
  /** 批量剪切放下：ids 按顺序一条接一条放进 assignee 那个组（null＝交接单专区／待定）。返回挪了几条。 */
  moveMany: (ids: string[], target: { assignee: string | null; anchorId?: string | null; place?: "above" | "below"; into?: string | null; bundleWith?: string | null }) =>
    ipcRenderer.invoke("bookmark:move-many", { ids, ...target }) as Promise<number>,
  setAssignee: (id: string, assignee: string | null) => ipcRenderer.invoke("bookmark:set-assignee", { id, assignee }),
  /** 搜看板：返回找到的条目 id、小模型认成同一个东西的项目名；小模型不通时 modelError 写原因。 */
  // part：fast＝按字＋按意思（快），projects＝小模型认项目名（慢）；不给＝三路都等完（2026-10-27）
  search: (query: string, part?: "fast" | "projects") => ipcRenderer.invoke("bookmark:search", part ? { query, part } : query) as Promise<{ ids: string[]; projects: string[]; modelError: string | null; byMeaning?: number; vectorError?: string | null }>,
  /** 交给哪套系统（根／燊一修）；null＝不标。 */
  setForSystem: (id: string, name: string | null) => ipcRenderer.invoke("bookmark:set-for-system", { id, name }),
  // 输入行自动存档（改版三）：草稿已入库后边写边改同一条。
  updateText: (id: string, text: string, url: string | null) => ipcRenderer.invoke("bookmark:update-text", { id, text, url }),
  /** 改详情（交接单展开的那段）；清空＝不要详情了。 */
  updateDetail: (id: string, detail: string) => ipcRenderer.invoke("bookmark:update-detail", { id, detail }),
  /** Ctrl+Z 撤回看板上最近一步；返回撤的是哪一步，没得撤是 null。 */
  undo: () => ipcRenderer.invoke("bookmark:undo") as Promise<string | null>,
  templates: () => ipcRenderer.invoke("bookmark:templates") as Promise<string[]>,
  copyForAgent: (id: string, template: string | null) => ipcRenderer.invoke("bookmark:copy-for-agent", { id, template }) as Promise<string>,
  openTemplates: () => ipcRenderer.invoke("bookmark:templates:open"),
  bundle: (id: string, targetId: string) => ipcRenderer.invoke("bookmark:bundle", { id, targetId }),
  unbundle: (bundleId: string) => ipcRenderer.invoke("bookmark:unbundle", bundleId),
  // 右键「捆成一捆」+ 捆名（设定21）
  bundleSelected: (ids: string[], name: string) => ipcRenderer.invoke("bookmark:bundle-selected", { ids, name }),
  bundleMeta: () => ipcRenderer.invoke("bookmark:bundle-meta") as Promise<Record<string, { name: string; by: "user" | "ai" }>>,
  // AI 整理（设定21）：设置窗口读写、整理一次（整理＋检查）、全部重来 / 撤销、模型加改删测、记录、小橙点；
  // 整理开始（空串）和整理完主进程各发一声过来
  organizerGet: () => ipcRenderer.invoke("bookmark:organizer:get"),
  organizerSet: (patch: { current?: string; enabled?: boolean; intervalHours?: number; effort?: string; rules?: string; checkRules?: string }) =>
    ipcRenderer.invoke("bookmark:organizer:set", patch),
  organizerModel: (payload: { action: "add" | "update" | "remove"; id?: string; provider?: string; baseUrl?: string; apiKey?: string; model?: string }) =>
    ipcRenderer.invoke("bookmark:organizer:model", payload),
  organizerTestModel: (payload: { id?: string; provider?: string; baseUrl?: string; apiKey?: string; model?: string }) =>
    ipcRenderer.invoke("bookmark:organizer:test-model", payload) as Promise<{ ok: boolean; text: string }>,
  organizerRun: () => ipcRenderer.invoke("bookmark:organizer:run"),
  organizerReset: () => ipcRenderer.invoke("bookmark:organizer:reset"),
  organizerUndoReset: () => ipcRenderer.invoke("bookmark:organizer:undo-reset"),
  organizerLedger: () => ipcRenderer.invoke("bookmark:organizer:ledger"),
  organizerRecords: () => ipcRenderer.invoke("bookmark:organizer:records"),
  organizerHints: () => ipcRenderer.invoke("bookmark:organizer:hints"),
  organizerNotes: () => ipcRenderer.invoke("bookmark:organizer:notes") as Promise<Record<string, { project: string; title: string; stale: boolean }>>,
  organizerDismiss: (itemId: string) => ipcRenderer.invoke("bookmark:organizer:dismiss", itemId),
  boardRules: () => ipcRenderer.invoke("bookmark:board-rules"),
  onOrganized: (callback: (text: string) => void) => {
    ipcRenderer.on("bookmark:organized", (_event, text) => callback(String(text ?? "")));
  },
  release: (id: string) => ipcRenderer.invoke("bookmark:release", id),
  // model：Pi 组六个点挑的模型，开窗前替用户在 Pi 里换成它（2026-10-27）。
  launchLine: (target: string, group: string, coding: boolean, model: string | null = null) =>
    ipcRenderer.invoke("bookmark:launch-line", { target, group, coding, model }) as Promise<{ line: string; label: string; model: string | null; opened: string | null; freshWindow: boolean; pasting: boolean; problem: string | null }>,
  // 派活单一键启动（设定23）：同批没人领的一个接一个开，撞文件就一个不开。
  // model：这批有 Pi 的单子时，开窗前替用户在 Pi 里换成它（2026-10-16）。
  launchBatch: (id: string, coding: boolean, model: string | null = null) =>
    ipcRenderer.invoke("bookmark:launch-batch", { id, coding, model }) as Promise<{
      launched: { name: string; label: string; opened: string; pasting: boolean }[];
      conflicts: { a: string; b: string; files: string[] }[];
      missing: string[];
      skipped: { name: string; reason: string }[];
      model: string | null;
    }>,
  piModels: () => ipcRenderer.invoke("bookmark:pi-models") as Promise<{ models: string[]; current: string | null }>,
  // 鼠标碰到看板就拿焦点、只碰没动就还回去（2026-10-24 看板 Claude 01）
  hoverFocus: () => ipcRenderer.invoke("bookmark:hover-focus") as Promise<boolean>,
  hoverGiveBack: () => ipcRenderer.invoke("bookmark:hover-give-back") as Promise<boolean>,
  // 点号码：复制这条那份单独小文件的路径（设定24）。
  itemFile: (id: string) => ipcRenderer.invoke("bookmark:item-file", id) as Promise<{ path: string; line: string }>,
  // 按住条目拖出看板：先拿那行字，再请主进程在小块上假按一下起系统拖拽（2026-10-27）。
  itemLine: (id: string) => ipcRenderer.invoke("bookmark:item-line", id) as Promise<string>,
  dragOutPress: (at: { x: number; y: number; dx: number }) => ipcRenderer.send("bookmark:drag-out-press", at),
  // 大标题右键复制路径：这一捆每条的单独文件（2026-10-27）。
  bundleFiles: (bundleId: string) => ipcRenderer.invoke("bookmark:bundle-files", bundleId) as Promise<{ line: string; count: number }>,
  // 启动 Agent 替用户贴完启动句（或没贴成）的结果。
  onLaunchPasted: (callback: (result: { label: string; ok: boolean; reason: string | null }) => void) => {
    ipcRenderer.on("bookmark:launch-pasted", (_event, result) => callback(result));
  },
  // Ctrl+R 换新代码的进度（看板、桌宠小窗口按的都在看板上提示，2026-10-24）
  onReloadProgress: (callback: (progress: { text: string; ms: number }) => void) => {
    ipcRenderer.on("bookmark:reload-progress", (_event, progress) => callback(progress));
  },
  // 两档（设定18）：日常档 / 睡觉档；切到睡觉档后开了哪几组的窗另发 bookmark:sleep-nudged。
  getMode: () => ipcRenderer.invoke("bookmark:mode:get") as Promise<"day" | "sleep">,
  setMode: (mode: "day" | "sleep") => ipcRenderer.invoke("bookmark:mode:set", mode) as Promise<"day" | "sleep">,
  onSleepNudged: (callback: (groups: string[]) => void) => {
    ipcRenderer.on("bookmark:sleep-nudged", (_event, groups) => callback(groups));
  },
  agents: () => ipcRenderer.invoke("bookmark:agents"),
  moveAgent: (name: string, anchor: string, place: "above" | "below") => ipcRenderer.invoke("bookmark:agents:move", { name, anchor, place }),
  addAgent: (name: string) => ipcRenderer.invoke("bookmark:agents:add", name),
  // 「更多 Agent」折叠区（2026-10-27）
  fold: () => ipcRenderer.invoke("bookmark:fold") as Promise<{ members: string[]; open: boolean }>,
  setFoldOpen: (open: boolean) => ipcRenderer.invoke("bookmark:fold:open", open) as Promise<{ members: string[]; open: boolean }>,
  setFolded: (name: string, on: boolean) => ipcRenderer.invoke("bookmark:fold:set", { name, on }) as Promise<{ members: string[]; open: boolean }>,
  removeAgent: (name: string) => ipcRenderer.invoke("bookmark:agents:remove", name),
  reload: () => ipcRenderer.invoke("bookmark:reload"),
  codeStatus: () => ipcRenderer.invoke("bookmark:code-status"),
  // 手机消息入库后的推送刷新（主进程收信后发 bookmark:inbox-changed）。
  onInboxChanged: (callback: () => void) => {
    ipcRenderer.on("bookmark:inbox-changed", () => callback());
  },
  // 外观设置（透明度滑条）：读用在首渲染前，写由滑条防抖调。
  getAppearance: () => ipcRenderer.invoke("bookmark:appearance:get") as Promise<number>,
  setAppearance: (opacity: number) => ipcRenderer.invoke("bookmark:appearance:set", opacity) as Promise<number>,
  // 📁 项目文件夹（第三页签）：真实文件夹+真实 md，存 bookmark\projects\；open 交系统默认程序。
  projectsList: (relative: string) => ipcRenderer.invoke("bookmark:projects:list", relative),
  projectsMkdir: (parent: string, name: string) => ipcRenderer.invoke("bookmark:projects:mkdir", { parent, name }),
  projectsTouch: (parent: string, name: string) => ipcRenderer.invoke("bookmark:projects:touch", { parent, name }),
  projectsReorder: (parent: string, moving: string, anchor: string, place: "above" | "below") =>
    ipcRenderer.invoke("bookmark:projects:reorder", { parent, moving, anchor, place }),
  projectsOpen: (relative: string) => ipcRenderer.invoke("bookmark:projects:open", relative),
});
