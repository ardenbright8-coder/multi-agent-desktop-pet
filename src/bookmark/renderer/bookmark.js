// Agent 看板界面（2026-09-10 照用户原型图改版）：分组条目、⊕无限加、💭待定区。
// 🚨 函数名一律 bm 前缀：跟 pet renderer 共享全局作用域池（边界检查②会扫），别撞名。
// 🚫 全程没有「确认/发送/取消」钮——任务行改动自动同步；组内输入行边写边自动存
// （2026-09-11 改版三，用户原话：写了就是写了，不用点保存）。

const BM_INBOX_KEY = "__inbox__"; // 💭 待定（想想区）：assignee 为空的普通条目都归这（交接单归专区，见下）
const BM_HANDOFF_ZONE_KEY = "__handoff_zone__"; // 📋 交接单专区：AI 写的未派发交接单默认落这（Agent分组页最底部·＋加Agent按钮上方，用户拍板位置别挪）
const BM_DEFAULT_ASSIGNEES = ["Claude", "ChatGPT", "Pi Agent", "Hermes"]; // 仅渲染兜底用，真名单以主进程为准
const BM_COLLAPSE_STORAGE_KEY = "bm-collapsed-groups";
const BM_DOT_PALETTE = ["#d9b98a", "#8fbf9f", "#7fa8c9", "#c9a0a8", "#a8b8d8", "#b9a0c9", "#c9b47f", "#9fb8c9"];
const bmOpenDetails = new Set(); // 点开过详情的条目 id：输入行自动存档会触发重画，别把人手点开的详情洗掉

let bmAgents = [...BM_DEFAULT_ASSIGNEES];
let bmCollapsed = bmLoadCollapsed();
let bmOpenComposerGroup = null; // 当前展开输入行的组 key
let bmCurrentPage = "inbox"; // 当前页签：inbox = 💭待定（默认） / groups = 🤖Agent 分组 / projects = 📁 项目（2026-09-11 加第三页）

function bmLoadCollapsed() {
  try {
    const raw = window.localStorage.getItem(BM_COLLAPSE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function bmSaveCollapsed() {
  try {
    window.localStorage.setItem(BM_COLLAPSE_STORAGE_KEY, JSON.stringify([...bmCollapsed]));
  } catch {
    // 存不了就算了，折叠状态是记忆便利不是数据。
  }
}

function bmDotColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return BM_DOT_PALETTE[hash % BM_DOT_PALETTE.length];
}

function bmInit() {
  // 版本戳：主进程通过 query 传进来的（git短hash·启动时间），reload 不变重启才变——一眼分辨新旧。
  const versionStamp = new URLSearchParams(window.location.search).get("v") ?? "";
  const versionEl = document.getElementById("title-version");
  if (versionEl) versionEl.textContent = versionStamp ? `v${versionStamp}` : "";
  // 透明度：首渲染前先应用存档（避免闪一下旧透明度），坏档/缺档主进程回落默认。
  void window.bookmark.getAppearance?.().then((opacity) => bmApplyOpacity(Number(opacity)));
  // 局部 Ctrl+R：重载面板（只在本窗口监听，🚨 不注册 globalShortcut，不拦其他软件）。
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "r" || event.key === "R")) {
      event.preventDefault();
      window.bookmark.reload();
    }
  });
  // 设置浮层（透明度滑条；以后设置项往这个浮层里加）。
  document.getElementById("settings-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    bmToggleSettings();
  });
  const slider = document.getElementById("opacity-slider");
  slider?.addEventListener("input", () => bmOnOpacityInput(Number(slider.value)));
  slider?.addEventListener("click", (event) => event.stopPropagation());
  // 页签在拖拽条目经过时自动切页（从待定拖到分组、或反向，中途不用松手）。
  for (const tab of document.querySelectorAll("#page-tabs .page-tab")) {
    tab.addEventListener("dragenter", (event) => {
      event.preventDefault();
      if (tab.dataset.page !== bmCurrentPage) bmSwitchPage(tab.dataset.page);
    });
  }
  // 页签切换：一次只见一页，每页占满面板（需求：待定/分组各自都能多放条目）。
  document.querySelectorAll("#page-tabs .page-tab").forEach((tab) => {
    tab.addEventListener("click", () => bmSwitchPage(tab.dataset.page));
  });
  document.getElementById("add-agent-btn").addEventListener("click", () => bmToggleAddAgentRow(true));
  document.getElementById("new-agent-ok").addEventListener("click", () => { void bmSubmitNewAgent(); });
  document.getElementById("new-agent-cancel").addEventListener("click", () => bmToggleAddAgentRow(false));
  document.getElementById("new-agent-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void bmSubmitNewAgent();
    }
    if (event.key === "Escape") bmToggleAddAgentRow(false);
  });
  document.addEventListener("click", (event) => {
    // 点菜单外面收起右键菜单。
    const menu = document.getElementById("ctx-menu");
    if (!menu.hidden && !menu.contains(event.target)) bmHideCtxMenu();
    // 点浮层外面收起设置浮层（浮层内部点击已 stopPropagation）。
    const pop = document.getElementById("settings-popover");
    if (pop && !pop.hidden && !pop.contains(event.target)) pop.hidden = true;
  });
  window.addEventListener("focus", () => { void bmRefresh(); });
  // 手机消息入库后的推送刷新（主进程收信后发 bookmark:inbox-changed）。
  window.bookmark.onInboxChanged?.(() => { void bmRefresh(); });
  void bmRefresh();
}

async function bmRefresh() {
  try {
    const [agents, records] = await Promise.all([window.bookmark.agents(), window.bookmark.list()]);
    bmAgents = Array.isArray(agents) && agents.length ? agents.map(String) : [...BM_DEFAULT_ASSIGNEES];
    bmRenderBoard(Array.isArray(records) ? records : []);
  } catch (error) {
    bmShowError("看板读不出来： " + bmErrorText(error));
  }
}

function bmErrorText(error) {
  return error && error.message ? String(error.message) : "未知错误";
}

// ── 分组计算 ─────────────────────────────────────────────

function bmGroupRecords(records) {
  const inbox = [];
  const handoffZone = [];
  const byAgent = new Map();
  const lowerAgents = new Set(bmAgents.map((name) => name.toLowerCase()));
  for (const record of records) {
    const owner = record.assignee ? String(record.assignee) : null;
    if (!owner || !lowerAgents.has(owner.toLowerCase())) {
      // 没派或派给了已删除的组 → 普通条目回待定区；交接单回交接单专区（用户拍板的默认落位）
      if (record.kind === "handoff") handoffZone.push(record);
      else inbox.push(record);
      continue;
    }
    const key = bmAgents.find((name) => name.toLowerCase() === owner.toLowerCase());
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(record);
  }
  return { inbox, byAgent, handoffZone };
}

// ── 渲染 ─────────────────────────────────────────────────

function bmRenderBoard(records) {
  const board = document.getElementById("board");
  board.textContent = "";
  const { inbox, byAgent, handoffZone } = bmGroupRecords(records);
  // 待定页签角标：两页都实时跟真数据对上（在分组页也能看到待定又多了几条）。
  const tabCount = document.getElementById("tab-inbox-count");
  if (tabCount) tabCount.textContent = String(inbox.length);
  // 一次只画当前页：待定页占满面板；分组页显示各 agent 组（加Agent 按钮只在分组页有意义）；项目页走真实文件夹浏览器。
  if (bmCurrentPage === "inbox") {
    board.appendChild(bmBuildGroup(BM_INBOX_KEY, "💭 待定（想想区）", inbox));
  } else if (bmCurrentPage === "projects") {
    void bmRenderProjects();
  } else {
    for (const name of bmAgents) {
      board.appendChild(bmBuildGroup(name, name, byAgent.get(name) ?? []));
    }
    // 交接单专区固定垫底：所有分组之后、底栏（＋加Agent）之前——别的位置不加。
    board.appendChild(bmBuildHandoffZone(handoffZone));
  }
  bmRestoreOpenComposer();
}

/** 切页签：改 active 态、重画 board、加Agent 按钮跟页走（待定页没它的事）。 */
function bmSwitchPage(page) {
  if (page !== "inbox" && page !== "groups" && page !== "projects") return;
  if (page === bmCurrentPage) return;
  bmCurrentPage = page;
  bmOpenComposerGroup = null; // 切页收起正在展开的输入行
  bmToggleAddAgentRow(false); // 收起加Agent 行（幂等）
  document.getElementById("add-agent-btn").hidden = page !== "groups";
  document.querySelectorAll("#page-tabs .page-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.page === page);
  });
  bmRenderCurrent();
}

function bmBuildGroup(key, displayName, records) {
  const group = document.createElement("section");
  group.className = "group" + (key === BM_INBOX_KEY ? " inbox" : "");
  group.dataset.group = key;

  const head = document.createElement("header");
  head.className = "group-head";
  // 拖拽改派的目标：条目拖到组头上松手 = 改派到这个组（待定区组头 = 收回待定）。
  head.addEventListener("dragover", (event) => {
    event.preventDefault();
    head.classList.add("drag-target");
  });
  head.addEventListener("dragleave", () => { head.classList.remove("drag-target"); });
  head.addEventListener("drop", (event) => {
    event.preventDefault();
    head.classList.remove("drag-target");
    const id = event.dataTransfer ? event.dataTransfer.getData("text/bm-id") : "";
    if (!id) return;
    const assignee = key === BM_INBOX_KEY ? null : bmAgents.find((name) => name === key) ?? null;
    void bmReassign(id, assignee);
  });
  head.addEventListener("dropend", () => { head.classList.remove("drag-target"); });

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = key === BM_INBOX_KEY ? "#b9c4a6" : bmDotColor(displayName);
  head.appendChild(dot);

  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = displayName;
  head.appendChild(name);

  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(records.length);
  head.appendChild(count);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "g-add";
  addBtn.title = key === BM_INBOX_KEY ? "记一条到待定区" : `给 ${displayName} 记一条`;
  addBtn.textContent = "＋";
  addBtn.addEventListener("click", () => bmToggleComposer(key));
  head.appendChild(addBtn);

  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "g-fold";
  fold.title = "收起 / 展开";
  fold.textContent = bmCollapsed.has(key) ? "›" : "⌄";
  fold.addEventListener("click", () => {
    if (bmCollapsed.has(key)) bmCollapsed.delete(key);
    else bmCollapsed.add(key);
    bmSaveCollapsed();
    bmRenderCurrent();
  });
  head.appendChild(fold);

  group.appendChild(head);

  if (bmOpenComposerGroup === key) group.appendChild(bmBuildComposer(key, displayName));

  if (!bmCollapsed.has(key)) {
    const list = document.createElement("ul");
    list.className = "task-list";
    if (!records.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = key === BM_INBOX_KEY ? "还没想好派给谁的，先放这。" : "这一组还没有任务，点 ＋ 记一条。";
      list.appendChild(empty);
    } else {
      records.forEach((record, index) => {
        list.appendChild(bmBuildTask(record, key, index + 1));
      });
    }
    group.appendChild(list);
  }
  return group;
}

function bmBuildTask(record, groupKey, order) {
  const item = document.createElement("li");
  item.className = "task";
  if (record.kind === "handoff") item.classList.add("handoff"); // 交接单：显眼样式（📋 标记+淡黄底），一眼认出
  item.dataset.id = record.id;
  // 拖拽改派：拖起来记 id，落到组头上由组头的 drop 处理。
  item.draggable = true;
  item.addEventListener("dragstart", (event) => {
    if (event.dataTransfer) {
      event.dataTransfer.setData("text/bm-id", record.id);
      event.dataTransfer.effectAllowed = "move";
    }
  });

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "handle";
  handle.title = "点开：派给 / 删除";
  handle.textContent = "⠿";
  handle.addEventListener("click", (event) => {
    event.stopPropagation();
    bmShowCtxMenu(record, groupKey, handle);
  });
  handle.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    bmShowCtxMenu(record, groupKey, handle);
  });
  item.appendChild(handle);

  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(order).padStart(2, "0");
  item.appendChild(num);

  const body = document.createElement("div");
  body.className = "task-body";
  if (record.kind === "handoff") {
    const badge = document.createElement("span");
    badge.className = "handoff-badge";
    badge.textContent = "📋 交接单";
    body.appendChild(badge);
  }
  const text = document.createElement("div");
  text.className = "task-text";
  text.textContent = record.text;
  body.appendChild(text);
  if (record.url) {
    const link = document.createElement("a");
    link.className = "task-url";
    link.href = record.url;
    link.textContent = record.url;
    body.appendChild(link);
  }
  // 详情（交接单的长内容）：有 detail 的条目点一下展开/收起，默认收起（板上只占标题两行）。
  // 展开态记进 bmOpenDetails：自动存档/改派触发重画后还原，别把点开的手气洗掉。
  if (record.detail) {
    const detail = document.createElement("div");
    detail.className = "task-detail";
    detail.textContent = record.detail;
    detail.hidden = !bmOpenDetails.has(record.id);
    body.appendChild(detail);
    item.classList.add("has-detail");
    const fold = document.createElement("span");
    fold.className = "detail-fold";
    fold.textContent = detail.hidden ? "▸ 详情" : "▾ 收起";
    body.appendChild(fold);
    body.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a")) return; // 链接照常点
      detail.hidden = !detail.hidden;
      if (detail.hidden) bmOpenDetails.delete(record.id);
      else bmOpenDetails.add(record.id);
      fold.textContent = detail.hidden ? "▸ 详情" : "▾ 收起";
    });
  }
  item.appendChild(body);
  return item;
}

function bmRenderCurrent() {
  // 折叠/展开只重排当前 DOM，不重新拉库（快速且不掉输入焦点）。
  void bmRefresh();
}

// ── 交接单专区（Agent分组页最底部）─────────────────────

/**
 * 📋 交接单专区：AI 干完活写的交接单（kind=handoff 且未派发）默认落这，用户拍板位置——
 * Agent分组页最底部、＋加Agent 按钮上方，别处不加。拖到哪个组头=派给谁（条目拖拽复用 bmBuildTask）。
 */
function bmBuildHandoffZone(records) {
  const group = document.createElement("section");
  group.className = "group handoff-zone";
  group.dataset.group = BM_HANDOFF_ZONE_KEY;

  const head = document.createElement("header");
  head.className = "group-head";

  const mark = document.createElement("span");
  mark.className = "handoff-zone-mark";
  mark.textContent = "📋";
  head.appendChild(mark);

  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = "交接单（AI 干完活留下的）";
  head.appendChild(name);

  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(records.length);
  head.appendChild(count);

  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "g-fold";
  fold.title = "收起 / 展开";
  fold.textContent = bmCollapsed.has(BM_HANDOFF_ZONE_KEY) ? "›" : "⌄";
  fold.addEventListener("click", () => {
    if (bmCollapsed.has(BM_HANDOFF_ZONE_KEY)) bmCollapsed.delete(BM_HANDOFF_ZONE_KEY);
    else bmCollapsed.add(BM_HANDOFF_ZONE_KEY);
    bmSaveCollapsed();
    bmRenderCurrent();
  });
  head.appendChild(fold);

  group.appendChild(head);

  if (!bmCollapsed.has(BM_HANDOFF_ZONE_KEY)) {
    const list = document.createElement("ul");
    list.className = "task-list";
    if (!records.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "还没有交接单。AI 干完活写的交接单默认落这，拖到哪个分组就派给谁。";
      list.appendChild(empty);
    } else {
      records.forEach((record, index) => {
        list.appendChild(bmBuildTask(record, BM_HANDOFF_ZONE_KEY, index + 1));
      });
    }
    group.appendChild(list);
  }
  return group;
}

// ── 📁 项目文件夹（第三页签：真实文件夹+真实 md，用户拍板）───────────────

let bmProjectsCwd = ""; // 当前所在相对路径（"" = projects 根）
let bmProjectsMode = null; // 新建输入行目标："folder" / "md" / null

/** 项目页渲染：返回上一级、新建两钮、当前夹列表（夹优先）；悬停夹自动弹目录预览。 */
async function bmRenderProjects() {
  const board = document.getElementById("board");
  board.textContent = "";
  bmHideProjPop();
  board.dataset.page = "projects";

  const bar = document.createElement("div");
  bar.className = "proj-bar";
  // 返回上一级：根上没有（已是顶层）。
  if (bmProjectsCwd) {
    const up = document.createElement("button");
    up.type = "button";
    up.className = "proj-up";
    up.textContent = "⬅ 上一级";
    up.addEventListener("click", () => {
      bmProjectsCwd = bmProjectsCwd.includes("/") ? bmProjectsCwd.slice(0, bmProjectsCwd.lastIndexOf("/")) : "";
      void bmRenderProjects();
    });
    bar.appendChild(up);
  }
  const crumbs = document.createElement("span");
  crumbs.className = "proj-crumbs";
  crumbs.textContent = "📁 项目" + (bmProjectsCwd ? " / " + bmProjectsCwd.split("/").join(" / ") : "");
  bar.appendChild(crumbs);
  const newFolder = document.createElement("button");
  newFolder.type = "button";
  newFolder.className = "proj-new-btn";
  newFolder.textContent = "＋ 新建项目夹";
  newFolder.addEventListener("click", () => bmToggleProjNewRow("folder"));
  bar.appendChild(newFolder);
  const newMd = document.createElement("button");
  newMd.type = "button";
  newMd.className = "proj-new-btn";
  newMd.textContent = "＋ 新建.md";
  newMd.addEventListener("click", () => bmToggleProjNewRow("md"));
  bar.appendChild(newMd);
  board.appendChild(bar);

  // 新建输入行（folder/md 两用，动态建——避免静态节点跨页搬家）。
  if (bmProjectsMode) board.appendChild(bmBuildProjNewRow(bmProjectsMode));

  let listing;
  try {
    listing = await window.bookmark.projectsList(bmProjectsCwd);
  } catch (error) {
    bmShowError("项目夹读不出来： " + bmErrorText(error));
    return;
  }

  const list = document.createElement("ul");
  list.className = "proj-list";
  if (!listing.dirs.length && !listing.files.length) {
    const empty = document.createElement("li");
    empty.className = "empty proj-empty";
    empty.textContent = bmProjectsCwd ? "这个夹还是空的，点上面建项目夹或建 .md。" : "还没有项目夹，点上面「＋ 新建项目夹」开一个。";
    list.appendChild(empty);
  }
  for (const dir of listing.dirs) list.appendChild(bmBuildProjectRow(dir));
  for (const file of listing.files) list.appendChild(bmBuildProjectRow(file));
  board.appendChild(list);
}

/** 单行：文件夹（单击进入+悬停自动弹目录预览）/ md（单击系统默认程序打开）。 */
function bmBuildProjectRow(entry) {
  const row = document.createElement("li");
  row.className = "proj-row" + (entry.isDir ? " is-dir" : " is-file");
  row.dataset.rel = entry.relPath;

  const icon = document.createElement("span");
  icon.className = "proj-icon";
  icon.textContent = entry.isDir ? "📁" : "📄";
  row.appendChild(icon);

  const name = document.createElement("span");
  name.className = "proj-name";
  name.textContent = entry.name;
  row.appendChild(name);

  if (entry.isDir) {
    // 悬停自动弹目录预览（用户原话：鼠标碰到就弹，不用点）；半秒延迟防乱弹。
    let hoverTimer = null;
    row.addEventListener("mouseenter", () => {
      hoverTimer = window.setTimeout(() => { void bmShowProjPop(entry, row); }, 500);
    });
    row.addEventListener("mouseleave", () => {
      if (hoverTimer) window.clearTimeout(hoverTimer);
      bmHideProjPop();
    });
    row.addEventListener("click", () => {
      bmProjectsCwd = entry.relPath;
      void bmRenderProjects();
    });
  } else {
    row.addEventListener("click", () => { void window.bookmark.projectsOpen(entry.relPath); });
  }
  return row;
}

/** 悬停预览：列出该夹里有什么（夹优先），贴着行右边弹。 */
async function bmShowProjPop(entry, anchor) {
  const pop = document.getElementById("proj-pop");
  pop.textContent = "";
  const title = document.createElement("div");
  title.className = "proj-pop-title";
  title.textContent = entry.name;
  pop.appendChild(title);
  try {
    const sub = await window.bookmark.projectsList(entry.relPath);
    const names = [...sub.dirs, ...sub.files].map((item) => (item.isDir ? "📁 " : "📄 ") + item.name);
    if (!names.length) {
      const empty = document.createElement("div");
      empty.className = "proj-pop-empty";
      empty.textContent = "（空夹）";
      pop.appendChild(empty);
    } else {
      for (const line of names.slice(0, 8)) {
        const item = document.createElement("div");
        item.className = "proj-pop-line";
        item.textContent = line;
        pop.appendChild(item);
      }
      if (names.length > 8) {
        const more = document.createElement("div");
        more.className = "proj-pop-empty";
        more.textContent = `…还有 ${names.length - 8} 项`;
        pop.appendChild(more);
      }
    }
  } catch (error) {
    const err = document.createElement("div");
    err.className = "proj-pop-empty";
    err.textContent = "读不了： " + bmErrorText(error);
    pop.appendChild(err);
  }
  const panelRect = document.getElementById("app").getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  pop.hidden = false;
  let left = rect.right - panelRect.left + 8;
  if (left + 200 > panelRect.width) left = Math.max(6, rect.left - panelRect.left - 206);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(6, rect.top - panelRect.top)}px`;
}

function bmHideProjPop() {
  const pop = document.getElementById("proj-pop");
  if (pop) pop.hidden = true;
}

/** 新建输入行开关（folder/md 两用，全局一行）。 */
function bmToggleProjNewRow(mode) {
  if (bmProjectsMode === mode) {
    bmProjectsMode = null;
  } else {
    bmProjectsMode = mode;
  }
  bmHideProjPop();
  void bmRenderProjects();
}

/** 新建输入行（folder/md 两用，动态建——照 composer 的样式路子）。 */
function bmBuildProjNewRow(mode) {
  const wrap = document.createElement("div");
  wrap.className = "proj-new-row";
  const kind = document.createElement("span");
  kind.className = "proj-new-kind";
  kind.textContent = mode === "folder" ? "📁" : "📄";
  wrap.appendChild(kind);
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.placeholder = mode === "folder" ? "项目夹名字（如：毕业旅行）" : "文档名字（自动补 .md）";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void bmSubmitProjNew(mode, input.value);
    }
    if (event.key === "Escape") {
      bmProjectsMode = null;
      void bmRenderProjects();
    }
  });
  wrap.appendChild(input);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "proj-new-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    bmProjectsMode = null;
    void bmRenderProjects();
  });
  wrap.appendChild(cancel);
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "proj-new-ok";
  ok.textContent = "创建";
  ok.addEventListener("click", () => { void bmSubmitProjNew(mode, input.value); });
  wrap.appendChild(ok);
  window.requestAnimationFrame(() => input.focus());
  return wrap;
}

async function bmSubmitProjNew(mode, rawValue) {
  const name = String(rawValue ?? "").trim();
  if (!name) {
    bmShowError("先写个名字");
    return;
  }
  try {
    if (mode === "folder") await window.bookmark.projectsMkdir(bmProjectsCwd, name);
    else await window.bookmark.projectsTouch(bmProjectsCwd, name);
    bmProjectsMode = null;
    bmShowError("");
    await bmRenderProjects();
  } catch (error) {
    bmShowError("建失败了： " + bmErrorText(error));
  }
}

// ── 组内输入行（⊕ 展开的内联输入；改版三 2026-09-11：边写边自动存，无「记下来/取消」钮）──

// 自动存档纪律（用户原话：写了就是写了，不用点保存）：打字防抖 400ms 落库；失焦/回车/⊕收起
// 必落盘；一份草稿只对应一条（首笔 add，之后 updateText 改同一条，别存出好几条）；
// 框清空 = 把存出来的那条删掉（框空=没这回事）。
const BM_COMPOSER_SAVE_DEBOUNCE_MS = 400;
// 当前草稿（一次只有一组输入行开着，一份就够）：groupKey=属于哪组；id=这份草稿落库生成的
// 条目（null=还没存过）；text=框里现值。
let bmComposerDraft = null;
let bmComposerSaveTimer = null;
// 失焦/防抖/收起可能背靠背触发：落库串行排队，别并发重复入库。
let bmComposerChain = Promise.resolve();

function bmScheduleComposerSave(groupKey, input) {
  if (bmComposerSaveTimer) window.clearTimeout(bmComposerSaveTimer);
  bmComposerSaveTimer = window.setTimeout(() => {
    bmComposerSaveTimer = null;
    void bmComposerCommit(groupKey, { input });
  }, BM_COMPOSER_SAVE_DEBOUNCE_MS);
}

/** 落库入口：排进串行队列（执行时才读最新草稿，排队期间接着打的字不会丢）。 */
function bmComposerCommit(groupKey, opts = {}) {
  const run = bmComposerChain.then(() => bmComposerCommitNow(groupKey, opts));
  bmComposerChain = run.catch(() => { /* 失败已在框上报错，别让队列断 */ });
  return run;
}

async function bmComposerCommitNow(groupKey, opts = {}) {
  if (bmComposerSaveTimer) {
    window.clearTimeout(bmComposerSaveTimer);
    bmComposerSaveTimer = null;
  }
  const draft = bmComposerDraft && bmComposerDraft.groupKey === groupKey ? bmComposerDraft : null;
  if (!draft) {
    // 框开着但一个字没打过：没得存；收起路径照样收。
    if (opts.close && bmOpenComposerGroup === groupKey) {
      bmOpenComposerGroup = null;
      await bmRefresh();
    }
    return;
  }
  const hadFocus = opts.input ? document.activeElement === opts.input : false;
  const caret = hadFocus && opts.input ? opts.input.selectionStart : null;
  const text = String(draft.text ?? "").trim();
  try {
    if (!text) {
      // 框清空了：这份草稿存出来的那条跟着删；本来就没存过就无事。
      if (draft.id) {
        await window.bookmark.remove(draft.id);
        draft.id = null;
      }
    } else if (draft.id) {
      // 已落库：改同一条。
      const url = bmDetectUrl(text);
      const body = url ? (text.replace(url, "").trim() || url) : text;
      const updated = await window.bookmark.updateText(draft.id, body, url);
      if (!updated) draft.id = null; // 条目被人删了（右键菜单）：下次落库重开一条，别拿死 id 白写。
    } else {
      const url = bmDetectUrl(text);
      const body = url ? (text.replace(url, "").trim() || url) : text;
      const assignee = groupKey === BM_INBOX_KEY ? null : bmAgents.find((name) => name === groupKey) ?? null;
      const record = await window.bookmark.add({ text: body, url, assignee, dedupeKey: null });
      draft.id = record.id;
    }
  } catch (error) {
    bmShowError("自动存档失败： " + bmErrorText(error));
    return; // 存失败不收起不重画：字还在框里，接着写下笔再存。
  }
  if (opts.close) {
    if (bmOpenComposerGroup === groupKey) bmOpenComposerGroup = null;
    if (bmComposerDraft === draft) bmComposerDraft = null;
    bmShowError("");
    await bmRefresh();
    return;
  }
  // 保持展开（打字中/失焦落盘后）：静默重画让列表和计数跟上，草稿文字随重画还回来
  // （bmBuildComposer 读草稿），焦点和光标也还回去。
  await bmRefresh();
  if (hadFocus) bmRefocusComposer(groupKey, caret);
}

/** 重画后把焦点还给输入框（用户在存档瞬间没点到别处才还）。 */
function bmRefocusComposer(groupKey, caret) {
  const active = document.activeElement;
  if (active && active !== document.body) return; // 人已点到别处，别把焦点拽回来。
  const input = document.querySelector(`.group[data-group="${CSS.escape(groupKey)}"] textarea`);
  if (!input) return;
  input.focus();
  const at = typeof caret === "number" ? caret : input.value.length;
  input.setSelectionRange(at, at);
}

function bmBuildComposer(groupKey, displayName) {
  const wrap = document.createElement("div");
  wrap.className = "group-composer";
  const input = document.createElement("textarea");
  input.id = groupKey === BM_INBOX_KEY ? "bm-inbox-input" : "bm-group-input";
  input.rows = 2;
  input.placeholder = groupKey === BM_INBOX_KEY
    ? "先记下来，想好派给谁再挪过去（边写边自动存）"
    : `给 ${displayName} 记一条（边写边自动存，Shift+Enter 换行）`;
  // 自动存档会触发重画：草稿文字读回来，别把人正在打的字冲掉。
  if (bmComposerDraft && bmComposerDraft.groupKey === groupKey) input.value = bmComposerDraft.text;
  input.addEventListener("input", (event) => {
    if (!bmComposerDraft || bmComposerDraft.groupKey !== groupKey) {
      bmComposerDraft = { groupKey, id: null, text: "" };
    }
    bmComposerDraft.text = input.value;
    if (event.isComposing) return; // 中文组字中不落库：别打断输入法，组完再存。
    bmScheduleComposerSave(groupKey, input);
  });
  input.addEventListener("compositionend", () => bmScheduleComposerSave(groupKey, input));
  input.addEventListener("blur", () => {
    // 失焦必落盘：挂着的防抖立刻执行，别等人回来。
    void bmComposerCommit(groupKey, { input });
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return; // 组字用的回车/Esc 别当「落盘收起」。
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void bmComposerCommit(groupKey, { close: true });
    }
    if (event.key === "Escape") {
      // 写了就是写了：Escape 只收起，已写的照存（挂着的防抖先落盘）。
      void bmComposerCommit(groupKey, { close: true });
    }
  });
  wrap.appendChild(input);

  const foot = document.createElement("div");
  foot.className = "composer-foot";
  const err = document.createElement("span");
  err.className = "composer-err";
  foot.appendChild(err);
  // 「记下来/取消」钮已撤（改版三 2026-09-11）：边写边自动存，写了就是写了。
  wrap.appendChild(foot);
  return wrap;
}

function bmToggleComposer(groupKey) {
  if (bmOpenComposerGroup === groupKey) {
    // ⊕ 再点一下收起：挂着的防抖先落盘（写了就是写了），再收。
    void bmComposerCommit(groupKey, { close: true });
    return;
  }
  bmOpenComposerGroup = groupKey;
  bmRenderCurrent();
  if (bmOpenComposerGroup === groupKey) {
    // 渲染完把焦点还给输入框。
    window.requestAnimationFrame(() => {
      const input = document.querySelector(`.group[data-group="${CSS.escape(groupKey)}"] textarea`);
      input?.focus();
    });
  }
}

function bmRestoreOpenComposer() {
  // bmRefresh 重画后保持展开状态由 bmOpenComposerGroup 驱动；草稿文字由 bmBuildComposer 读 bmComposerDraft 还原。
}

function bmDetectUrl(text) {
  const match = text.match(/https?:\/\/[^\s，。、）)】”]+/i);
  return match ? match[0] : null;
}

// ── 右键菜单：派给 / 收回待定 / 删除 ──────────────────────

function bmShowCtxMenu(record, groupKey, anchor) {
  const menu = document.getElementById("ctx-menu");
  menu.textContent = "";

  const title = document.createElement("div");
  title.className = "ctx-title";
  title.textContent = "派给 →";
  menu.appendChild(title);

  const targets = bmAgents.filter((name) => name.toLowerCase() !== groupKey.toLowerCase());
  if (!targets.length) {
    const none = document.createElement("div");
    none.className = "ctx-none";
    none.textContent = "（还没有其他分组）";
    menu.appendChild(none);
  }
  for (const name of targets) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ctx-item";
    item.textContent = name;
    item.addEventListener("click", () => { void bmReassign(record.id, name); });
    menu.appendChild(item);
  }

  if (bmAgents.some((name) => name === groupKey)) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ctx-item back";
    // 交接单收回=回专区（未派发交接单的默认落位），普通条目收回=回待定区。
    back.textContent = record.kind === "handoff" ? "收回交接单专区" : "收回待定";
    back.addEventListener("click", () => { void bmReassign(record.id, null); });
    menu.appendChild(back);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "ctx-item danger";
  del.textContent = "删除这条";
  del.addEventListener("click", () => { void bmRemove(record.id); });
  menu.appendChild(del);

  menu.hidden = false;
  // 贴着手柄弹，别出窗口。
  const panelRect = document.getElementById("app").getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const menuWidth = 168;
  const menuHeightEstimate = 40 + targets.length * 30 + 60;
  let left = rect.right - panelRect.left + 6;
  if (left + menuWidth > panelRect.width) left = rect.left - panelRect.left - menuWidth - 6;
  let top = rect.top - panelRect.top;
  if (top + menuHeightEstimate > panelRect.height) top = Math.max(8, panelRect.height - menuHeightEstimate - 8);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
}

function bmHideCtxMenu() {
  document.getElementById("ctx-menu").hidden = true;
}

async function bmReassign(id, assignee) {
  try {
    await window.bookmark.setAssignee(id, assignee);
    bmHideCtxMenu();
    await bmRefresh();
  } catch (error) {
    bmShowError("改派失败了： " + bmErrorText(error));
  }
}

async function bmRemove(id) {
  try {
    await window.bookmark.remove(id);
    bmOpenDetails.delete(id); // 条目没了，展开手气也一并清掉，别攒脏 id
    bmHideCtxMenu();
    await bmRefresh();
  } catch (error) {
    bmShowError("删失败了： " + bmErrorText(error));
  }
}

// ── 加Agent ──────────────────────────────────────────────

function bmToggleAddAgentRow(show) {
  const row = document.getElementById("add-agent-row");
  row.hidden = !show;
  document.getElementById("add-agent-btn").hidden = show;
  if (show) document.getElementById("new-agent-name").focus();
}

async function bmSubmitNewAgent() {
  const input = document.getElementById("new-agent-name");
  const name = input.value.trim();
  if (!name) {
    bmShowError("先写个 Agent 名字");
    return;
  }
  try {
    await window.bookmark.addAgent(name);
    input.value = "";
    bmToggleAddAgentRow(false);
    bmShowError("");
    await bmRefresh();
  } catch (error) {
    bmShowError("加分组失败了： " + bmErrorText(error));
  }
}

// ── 外观设置（透明度）：左下角小齿轮 → 浮层滑条实时预览，防抖存档 ──

function bmApplyOpacity(opacity) {
  const value = Math.min(0.95, Math.max(0.3, Number.isFinite(opacity) ? opacity : 0.6));
  document.documentElement.style.setProperty("--bm-alpha", String(value));
  const readout = document.getElementById("opacity-value");
  if (readout) readout.textContent = Math.round(value * 100) + "%";
  const slider = document.getElementById("opacity-slider");
  if (slider && document.activeElement !== slider) slider.value = String(value);
}

function bmToggleSettings() {
  const pop = document.getElementById("settings-popover");
  if (!pop) return;
  pop.hidden = !pop.hidden;
}

let bmOpacitySaveTimer = null;

function bmOnOpacityInput(value) {
  bmApplyOpacity(value); // 滑动实时预览
  if (bmOpacitySaveTimer) window.clearTimeout(bmOpacitySaveTimer);
  bmOpacitySaveTimer = window.setTimeout(() => {
    void window.bookmark.setAppearance?.(Number(document.getElementById("opacity-slider").value));
  }, 500); // 防抖半秒：滑完才落盘，不写坏盘
}

// ── 杂项 ─────────────────────────────────────────────────

function bmShowError(message) {
  const errorLine = document.getElementById("board-error");
  errorLine.textContent = message;
  if (message) {
    window.clearTimeout(bmShowError._timer);
    bmShowError._timer = window.setTimeout(() => { errorLine.textContent = ""; }, 4000);
  }
}

bmInit();
