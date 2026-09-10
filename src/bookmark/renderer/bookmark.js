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
  document.getElementById("hide-btn").addEventListener("click", () => { window.bookmark.hide(); });
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
  });
  window.addEventListener("focus", () => { void bmRefresh(); });
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
  board.appendChild(bmBuildGroup(BM_INBOX_KEY, "💭 待定（想想区）", inbox));
  for (const name of bmAgents) {
    board.appendChild(bmBuildGroup(name, name, byAgent.get(name) ?? []));
  }
  bmRestoreOpenComposer();
}

function bmBuildGroup(key, displayName, records) {
  const group = document.createElement("section");
  group.className = "group" + (key === BM_INBOX_KEY ? " inbox" : "");
  group.dataset.group = key;

  const head = document.createElement("header");
  head.className = "group-head";

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
  item.dataset.id = record.id;

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
