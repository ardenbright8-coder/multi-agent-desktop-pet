// Agent 看板界面（2026-09-10 照用户原型图改版）：分组条目、⊕无限加、💭待定区、无手动确认按钮。
// 🚨 函数名一律 bm 前缀：跟 pet renderer 共享全局作用域池（边界检查②会扫），别撞名。
// 🚫 行尾没有任何"确认/发送"圆钮——记一条自动同步（用户原话：麻烦死了）。

const BM_INBOX_KEY = "__inbox__"; // 💭 待定（想想区）：assignee 为空的条目都归这
const BM_DEFAULT_ASSIGNEES = ["Claude", "ChatGPT", "Pi Agent", "Hermes"]; // 仅渲染兜底用，真名单以主进程为准
const BM_COLLAPSE_STORAGE_KEY = "bm-collapsed-groups";
const BM_DOT_PALETTE = ["#d9b98a", "#8fbf9f", "#7fa8c9", "#c9a0a8", "#a8b8d8", "#b9a0c9", "#c9b47f", "#9fb8c9"];

let bmAgents = [...BM_DEFAULT_ASSIGNEES];
let bmCollapsed = bmLoadCollapsed();
let bmOpenComposerGroup = null; // 当前展开输入行的组 key
let bmCurrentPage = "inbox"; // 当前页签：inbox = 💭待定（默认） / groups = 🤖Agent 分组（2026-09-10 拍板的两页切换）

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
  document.getElementById("hide-btn").addEventListener("click", () => { window.bookmark.hide(); });
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
  const byAgent = new Map();
  const lowerAgents = new Set(bmAgents.map((name) => name.toLowerCase()));
  for (const record of records) {
    const owner = record.assignee ? String(record.assignee) : null;
    if (!owner || !lowerAgents.has(owner.toLowerCase())) {
      inbox.push(record); // 没派或派给了已删除的组 → 都回待定区
      continue;
    }
    const key = bmAgents.find((name) => name.toLowerCase() === owner.toLowerCase());
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(record);
  }
  return { inbox, byAgent };
}

// ── 渲染 ─────────────────────────────────────────────────

function bmRenderBoard(records) {
  const board = document.getElementById("board");
  board.textContent = "";
  const { inbox, byAgent } = bmGroupRecords(records);
  // 待定页签角标：两页都实时跟真数据对上（在分组页也能看到待定又多了几条）。
  const tabCount = document.getElementById("tab-inbox-count");
  if (tabCount) tabCount.textContent = String(inbox.length);
  // 一次只画当前页：待定页占满面板；分组页显示各 agent 组（加Agent 按钮只在分组页有意义）。
  if (bmCurrentPage === "inbox") {
    board.appendChild(bmBuildGroup(BM_INBOX_KEY, "💭 待定（想想区）", inbox));
  } else {
    for (const name of bmAgents) {
      board.appendChild(bmBuildGroup(name, name, byAgent.get(name) ?? []));
    }
  }
  bmRestoreOpenComposer();
}

/** 切页签：改 active 态、重画 board、加Agent 按钮跟页走（待定页没它的事）。 */
function bmSwitchPage(page) {
  if (page !== "inbox" && page !== "groups") return;
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
  if (record.detail) {
    const detail = document.createElement("div");
    detail.className = "task-detail";
    detail.textContent = record.detail;
    detail.hidden = true;
    body.appendChild(detail);
    item.classList.add("has-detail");
    const fold = document.createElement("span");
    fold.className = "detail-fold";
    fold.textContent = "▸ 详情";
    body.appendChild(fold);
    body.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a")) return; // 链接照常点
      detail.hidden = !detail.hidden;
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

// ── 组内输入行（⊕ 展开的内联输入）──────────────────────

function bmBuildComposer(groupKey, displayName) {
  const wrap = document.createElement("div");
  wrap.className = "group-composer";
  const input = document.createElement("textarea");
  input.id = groupKey === BM_INBOX_KEY ? "bm-inbox-input" : "bm-group-input";
  input.rows = 2;
  input.placeholder = groupKey === BM_INBOX_KEY
    ? "先记下来，想好派给谁再挪过去（Enter 记下）"
    : `给 ${displayName} 记一条（Enter 记下，Shift+Enter 换行）`;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void bmSubmitComposer(groupKey, input.value);
    }
    if (event.key === "Escape") {
      bmOpenComposerGroup = null;
      bmRenderCurrent();
    }
  });
  wrap.appendChild(input);

  const foot = document.createElement("div");
  foot.className = "composer-foot";
  const err = document.createElement("span");
  err.className = "composer-err";
  foot.appendChild(err);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "g-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    bmOpenComposerGroup = null;
    bmRenderCurrent();
  });
  foot.appendChild(cancel);
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "g-ok";
  ok.textContent = "记下来";
  ok.addEventListener("click", () => { void bmSubmitComposer(groupKey, input.value); });
  foot.appendChild(ok);
  wrap.appendChild(foot);
  return wrap;
}

function bmToggleComposer(groupKey) {
  bmOpenComposerGroup = bmOpenComposerGroup === groupKey ? null : groupKey;
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
  // bmRefresh 重画后保持展开状态由 bmOpenComposerGroup 驱动，无需额外处理。
}

async function bmSubmitComposer(groupKey, rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) {
    bmShowError("先写点什么再记");
    return;
  }
  const url = bmDetectUrl(text);
  const body = url ? (text.replace(url, "").trim() || url) : text;
  const assignee = groupKey === BM_INBOX_KEY ? null : bmAgents.find((name) => name === groupKey) ?? null;
  try {
    await window.bookmark.add({ text: body, url, assignee, dedupeKey: null });
    bmOpenComposerGroup = null;
    bmShowError("");
    await bmRefresh();
  } catch (error) {
    bmShowError("记失败了： " + bmErrorText(error));
  }
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

  if (groupKey !== BM_INBOX_KEY) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ctx-item back";
    back.textContent = "收回待定";
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
