// 书签台界面：输入、交给谁、列表。独立窗口自含，不经 shell.js 调度。
// 🚨 函数名一律 bm 前缀：这个文件跟 pet renderer 的 script 共享全局作用域池（边界检查②会扫），
//    别用 render/refresh/formatTime 这种大路名，撞了 pet 的全局函数就是跨块互调。

const BM_DEFAULT_ASSIGNEES = ["Claude", "Grok", "Pi", "Hermes"];

let bmSelectedAssignee = null;

function bmInit() {
  const input = document.getElementById("input");
  const addBtn = document.getElementById("add-btn");
  const hideBtn = document.getElementById("hide-btn");
  const customAssignee = document.getElementById("custom-assignee");

  bmRenderChips();
  bmRefresh();

  addBtn.addEventListener("click", () => { void bmSubmit(); });
  hideBtn.addEventListener("click", () => { window.bookmark.hide(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void bmSubmit();
    }
  });
  customAssignee.addEventListener("input", () => bmSyncChipSelection());
  window.addEventListener("focus", () => bmRefresh());
}

function bmRenderChips() {
  const chips = document.getElementById("chips");
  chips.textContent = "";
  for (const name of BM_DEFAULT_ASSIGNEES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.assignee = name;
    chip.textContent = name;
    chip.addEventListener("click", () => {
      bmSelectedAssignee = bmSelectedAssignee === name ? null : name;
      bmSyncChipSelection();
    });
    chips.appendChild(chip);
  }
}

function bmSyncChipSelection() {
  const custom = document.getElementById("custom-assignee");
  const customValue = custom.value.trim();
  document.querySelectorAll("#chips .chip").forEach((chip) => {
    chip.classList.toggle("selected", !customValue && chip.dataset.assignee === bmSelectedAssignee);
  });
}

function bmCurrentAssignee() {
  const custom = document.getElementById("custom-assignee");
  return custom.value.trim() || bmSelectedAssignee;
}

async function bmSubmit() {
  const input = document.getElementById("input");
  const errorLine = document.getElementById("composer-error");
  const text = input.value.trim();
  if (!text) {
    bmShowError("先写点什么再记");
    return;
  }
  const url = bmDetectUrl(text);
  const body = url ? (text.replace(url, "").trim() || url) : text;
  try {
    await window.bookmark.add({
      text: body,
      url,
      assignee: bmCurrentAssignee() || null,
    });
    input.value = "";
    bmShowError("");
    bmRefresh();
    input.focus();
  } catch (error) {
    bmShowError(error && error.message ? String(error.message) : "记失败了，再试一次");
  }
}

function bmDetectUrl(text) {
  const match = text.match(/https?:\/\/[^\s，。、）)】”]+/i);
  return match ? match[0] : null;
}

async function bmRefresh() {
  let records = [];
  try {
    records = await window.bookmark.list();
  } catch (error) {
    bmShowError("列表读不出来： " + (error && error.message ? String(error.message) : "未知错误"));
    return;
  }
  bmRenderList(records);
}

function bmRenderList(records) {
  const list = document.getElementById("list");
  list.textContent = "";
  if (!records.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "还没有记录。想到什么，随手记一条。";
    list.appendChild(empty);
    return;
  }
  for (const record of records) {
    list.appendChild(bmBuildItem(record));
  }
}

function bmBuildItem(record) {
  const item = document.createElement("li");
  item.className = "item";

  const body = document.createElement("div");
  body.className = "body";

  const text = document.createElement("div");
  text.className = "text";
  text.textContent = record.text;
  body.appendChild(text);

  if (record.url) {
    const link = document.createElement("a");
    link.className = "url";
    link.href = record.url;
    link.textContent = record.url;
    body.appendChild(link);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const badge = document.createElement("span");
  badge.className = record.assignee ? "badge" : "badge none";
  badge.textContent = record.assignee ? `交给 ${record.assignee}` : "未指派";
  meta.appendChild(badge);
  const time = document.createElement("span");
  time.textContent = bmFormatTime(record.createdAt);
  meta.appendChild(time);
  body.appendChild(meta);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.title = "删掉这条";
  del.textContent = "✕";
  del.addEventListener("click", () => { void bmRemove(record.id); });

  item.appendChild(body);
  item.appendChild(del);
  return item;
}

async function bmRemove(id) {
  try {
    await window.bookmark.remove(id);
    bmRefresh();
  } catch (error) {
    bmShowError("删失败了： " + (error && error.message ? String(error.message) : "未知错误"));
  }
}

function bmShowError(message) {
  const errorLine = document.getElementById("composer-error");
  errorLine.textContent = message;
  if (message) {
    window.clearTimeout(bmShowError._timer);
    bmShowError._timer = window.setTimeout(() => { errorLine.textContent = ""; }, 4000);
  }
}

function bmFormatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? `今天 ${hhmm}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

bmInit();
