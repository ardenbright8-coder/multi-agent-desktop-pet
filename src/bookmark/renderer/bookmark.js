// Agent 看板界面（2026-09-10 照用户原型图改版）：分组条目、⊕无限加、💭待定区。
// 🚨 函数名一律 bm 前缀：跟 pet renderer 共享全局作用域池（边界检查②会扫），别撞名。
// 🚫 全程没有「确认/发送/取消」钮——任务行改动自动同步；组内输入行边写边自动存
// （2026-09-11 改版三，用户原话：写了就是写了，不用点保存）。

const BM_INBOX_KEY = "__inbox__"; // 💭 待定（想想区）：assignee 为空的普通条目都归这（交接单归专区，见下）
const BM_HANDOFF_ZONE_KEY = "__handoff_zone__"; // 📋 交接单专区：AI 写的未派发交接单默认落这（Agent分组页最底部·＋加Agent按钮上方，用户拍板位置别挪）
const BM_DEFAULT_ASSIGNEES = ["Claude", "ChatGPT", "Pi Agent", "Hermes"]; // 仅渲染兜底用，真名单以主进程为准
const BM_DOT_PALETTE = ["#d9b98a", "#8fbf9f", "#7fa8c9", "#c9a0a8", "#a8b8d8", "#b9a0c9", "#c9b47f", "#9fb8c9"];
const bmOpenDetails = new Set(); // 点开过详情的条目 id：输入行自动存档会触发重画，别把人手点开的详情洗掉

let bmAgents = [...BM_DEFAULT_ASSIGNEES];
let bmOpenComposerGroup = null; // 当前展开输入行的组 key
let bmCurrentPage = "inbox"; // 当前页签：inbox = 💭待定（默认） / groups = 🤖Agent 分组 / projects = 📁 项目（2026-09-11 加第三页）
let bmInsertDraft = null; // 右键插进来、还在写的那一行：{ groupKey, anchorId, place, id, text, kind }
let bmEditingId = null; // 点白条正在改的那条
let bmInsertSaveTimer = null;
let bmEditSaveTimer = null;

function bmDotColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return BM_DOT_PALETTE[hash % BM_DOT_PALETTE.length];
}

let bmToastTimer = null;
function bmToast(msg, ms) {
  const el = document.getElementById("bm-toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(bmToastTimer);
  bmToastTimer = setTimeout(() => { el.hidden = true; }, ms || 2000);
}
// 细线图标（2026-09-24 用户拍板：照 ChatGPT 那排按钮，细线、小、不带圈，比字符和 emoji 清爽）。
const BM_ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8.5 8.5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6.5a2.5 2.5 0 0 0-2.5-2.5H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
};
// 组名前的官方标志（2026-09-24 用户拍板：比圆点专业）。Claude/OpenAI 取自 simple-icons 开源图标库，
// Pi 取自 pi.dev 官网，Hermes 官网图标就是 ⚕；原文件在 E 盘 40_下载资产「AI官方标志」夹。认不出的组照旧叶形圆点。
const BM_LOGOS = {
  claude: '<svg viewBox="0 0 24 24"><path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  openai: '<svg viewBox="0 0 24 24"><path fill="#2f3e2c" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  pi: '<svg viewBox="140 140 520 520"><path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/></svg>',
  hermes: '<svg viewBox="0 0 24 24"><text x="12" y="22" text-anchor="middle" font-size="27" font-weight="700" fill="#3d5a2c">⚕</text></svg>',
};
function bmLogoKey(name) {
  const n = String(name).toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("chatgpt") || n.includes("codex") || n.includes("openai")) return "openai";
  if (n === "pi" || n.startsWith("pi ")) return "pi";
  if (n.includes("hermes")) return "hermes";
  return null;
}
function bmIcon(name) {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BM_ICONS[name]}</svg>`;
}
function bmClock(ms) {
  const d = new Date(Number(ms) || 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function bmReportJustRelaunched() {
  const key = "bm-just-relaunched";
  const justAt = Number(window.localStorage.getItem(key) || 0);
  if (!justAt) return false;
  window.localStorage.removeItem(key);
  if (Date.now() - justAt < 5 * 60 * 1000) {
    bmToast("🌲 已重启，现在跑的是最新代码", 3500);
    return true;
  }
  return false;
}
async function bmReportCodeFreshness() {
  if (!window.bookmark.codeStatus) {
    bmToast("⚠️ 这个窗口挂在一个旧程序上，新功能可能用不了。把桌宠完全退出再开一次", 9000);
    return;
  }
  try {
    const status = await window.bookmark.codeStatus();
    if (!status) {
      bmToast("⚠️ 这个窗口挂在一个旧程序上，新功能可能用不了。把桌宠完全退出再开一次", 9000);
      return;
    }
    if (Number(status.stale)) {
      bmToast(`⚠️ 代码在 ${bmClock(status.codeAt)} 更新过，你现在跑的还是 ${bmClock(status.startedAt)} 启动的那份。按 Ctrl+R 换上新的`, 9000);
      return;
    }
    bmToast(`🌲 代码是最新的（${bmClock(status.codeAt)} 那版）`, 2500);
  } catch {
    bmToast("⚠️ 这个窗口挂在一个旧程序上，新功能可能用不了。把桌宠完全退出再开一次", 9000);
  }
}

function bmInit() {
  // 版本戳：主进程通过 query 传进来的（git短hash·启动时间），页面刷新不变，Ctrl+R 整程序重开才变。
  const versionStamp = new URLSearchParams(window.location.search).get("v") ?? "";
  const versionEl = document.getElementById("title-version");
  if (versionEl) versionEl.textContent = versionStamp ? `v${versionStamp}` : "";
  const justRelaunchedKey = "bm-just-relaunched";
  // 跟脑图同一套：新旧都要报。不弹他就分不清是最新还是功能没生效。
  if (!bmReportJustRelaunched()) setTimeout(() => { void bmReportCodeFreshness(); }, 1500);
  // 透明度：首渲染前先应用存档（避免闪一下旧透明度），坏档/缺档主进程回落默认。
  void window.bookmark.getAppearance?.().then((opacity) => bmApplyOpacity(Number(opacity)));
  // 局部 Ctrl+R：真机编译+整程序重开（只在本窗口监听，🚨 不注册 globalShortcut，不拦其他软件）。
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "r" || event.key === "R")) {
      event.preventDefault();
      window.localStorage.setItem(justRelaunchedKey, String(Date.now()));
      bmToast("正在换成最新代码…", 8000);
      void Promise.resolve(window.bookmark.reload()).then((result) => {
        if (!result || result.mode === "reload") {
          window.localStorage.removeItem(justRelaunchedKey);
          bmToast("🌲 代码是最新的", 2000);
          return;
        }
        if (result.ok === false) {
          window.localStorage.removeItem(justRelaunchedKey);
          bmToast("换新失败（看日志）", 5000);
        }
      }).catch(() => {
        window.localStorage.removeItem(justRelaunchedKey);
        bmToast("换新失败（看日志）", 5000);
      });
    }
  });
  // 设置浮层（透明度滑条；以后设置项往这个浮层里加）。
  document.getElementById("settings-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    bmToggleSettings();
  });
  bmAddTemplatesSettingRow();
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
  // 启动 Agent 贴字结果（设定15第三版）：贴了就提醒看一眼再回车；没贴就说为什么、让用户自己贴。
  // 两档（设定18）：☀️ 日常档 / 🌙 睡觉档，标题栏点一下切换。切到睡觉档，看板马上看一眼、有活没人干的组开好窗贴好领活那句。
  const modeBtn = document.getElementById("mode-btn");
  const paintMode = (mode) => {
    modeBtn.textContent = mode === "sleep" ? "🌙 睡觉档" : "☀️ 日常档";
    modeBtn.classList.toggle("sleep", mode === "sleep");
  };
  void window.bookmark.getMode?.().then(paintMode).catch(() => {});
  modeBtn.addEventListener("click", async () => {
    try {
      const mode = await window.bookmark.setMode(modeBtn.classList.contains("sleep") ? "day" : "sleep");
      paintMode(mode);
      if (mode === "sleep") bmToast("已切到睡觉档：AI 干完一条写好大白话报告就接着领下一条，不等你说可以；每半小时看一眼有没有组有活没人干", 8000);
      else bmToast("已切回日常档：AI 干完先给你验，你说可以再删", 5000);
    } catch (error) {
      bmShowError(bmErrorText(error));
    }
  });
  window.bookmark.onSleepNudged?.((groups) => {
    bmToast(`睡觉档：${groups.join("、")} 组有活没人干，开好窗、贴好领活那句了（没按回车，你按一下它就开干）`, 12000);
  });
  window.bookmark.onLaunchPasted?.((r) => {
    if (r.ok) bmToast(`启动句已贴进 ${r.label} 窗口，没按回车：你看一眼再按回车`, 8000);
    else bmToast(`${r.reason}，没替你贴：点一下 ${r.label} 窗口，Ctrl+V 再回车`, 8000);
  });
  void bmRefresh();
}

async function bmRefresh() {
  try {
    const [agents, records] = await Promise.all([window.bookmark.agents(), window.bookmark.list()]);
    bmAgents = Array.isArray(agents) && agents.length ? agents.map(String) : [...BM_DEFAULT_ASSIGNEES];
    // 手里正按着一条时不重画（重画会把按着的那条换掉，影子收不回来留成残影），松手再补画。
    if (bmDragActive || bmImagesBusy) {
      bmRefreshPending = true;
      return;
    }
    // 正在输入行 / 改字框里打字时重画：画完把光标放回去，不然框收不起来、字也接不上。
    const active = bmActiveImageInput();
    // 每组都有空白框，输入框要按「哪个组、是不是空白框」找回来，不能拿第一个 .insert-row 凑数。
    const typing = active && active.matches && active.matches(".insert-row textarea, .task-edit")
      ? {
          edit: active.matches(".task-edit"),
          group: active.closest(".group")?.dataset.group ?? null,
          blank: Boolean(active.closest(".blank-row")),
          caret: active.selectionStart,
          end: active.selectionEnd,
          text: active.value,
        }
      : null;
    if (typing && bmEditingId) {
      const current = records.find((record) => record.id === bmEditingId);
      if (current) current.text = typing.text;
    }
    bmRepainting = true;
    try {
      bmRenderBoard(Array.isArray(records) ? records : []);
    } finally {
      bmRepainting = false;
    }
    if (typing) {
      const input = typing.edit ? document.querySelector(".task-edit") : bmFindInsertInput(typing.group, typing.blank);
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(typing.caret, typing.end);
        bmFitTextarea(input);
      }
    }
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
  if (bmImagesBusy) return;
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

// 鼠标按下后挪过这么多像素就算拖（不用等）；没挪就松开才算单击。大厂拖拽库鼠标默认也是这套，按住等一会儿是给触屏的。
const BM_DRAG_SLOP = 5;
let bmDragActive = false; // 从按下到松手都算，期间 bmRefresh 只记账不重画
let bmRefreshPending = false;
let bmRepainting = false; // 重画拔掉正在打字的框时浏览器会报「失焦」，那不是人点了别处，输入框别当真收起

/** 左键按下直接挪就是拖。拖到哪条缝，两边散开；松手插进去。不走系统拖放，所以不会出禁止符号。 */
function bmBindDrag(opts) {
  const handle = opts.handle;
  const row = opts.row;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, textarea, input, a, .handle, .bm-rich-input")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let armed = false;
    let ghost = null;
    let scrollTimer = 0;
    let lastX = startX;
    let lastY = startY;
    let hit = null;
    bmDragActive = true;

    function clearMarks() {
      document.querySelectorAll(".gap-above, .gap-below, .drag-target, .bundle-target").forEach((el) => {
        el.classList.remove("gap-above", "gap-below", "drag-target", "bundle-target");
      });
    }
    function finish(commit) {
      if (scrollTimer) window.clearInterval(scrollTimer);
      clearMarks();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (ghost) ghost.remove();
      row.classList.remove("is-dragging");
      bmDragActive = false;
      const pending = bmRefreshPending;
      bmRefreshPending = false;
      if (armed) row.dataset.swallow = "1";
      const drop = armed && commit && hit && opts.onDrop ? hit : null;
      void (async () => {
        if (drop) await opts.onDrop(drop);
        if (pending) await bmRefresh();
      })();
    }
    function arm() {
      // 按着的这条已经被重画换掉了：这次拖动作废，别拿旧条目做影子。
      if (!row.isConnected) {
        finish(false);
        return;
      }
      armed = true;
      const rect = row.getBoundingClientRect();
      row.classList.add("is-dragging");
      ghost = row.cloneNode(true);
      ghost.classList.remove("is-dragging");
      ghost.classList.add("drag-ghost");
      ghost.style.width = rect.width + "px";
      ghost.style.left = rect.left + "px";
      ghost.style.top = rect.top + "px";
      document.body.appendChild(ghost);
      try { handle.setPointerCapture(pointerId); } catch (e) { /* 捕不到也不挡拖 */ }
      scrollTimer = window.setInterval(() => bmDragScroll(lastY), 40);
      paint(lastX, lastY);
    }
    function paint(x, y) {
      if (ghost) {
        ghost.style.left = (x - 28) + "px";
        ghost.style.top = (y - 18) + "px";
      }
      clearMarks();
      hit = null;
      if (opts.reassign) {
        const under = document.elementFromPoint(x, y);
        const head = under && under.closest ? under.closest(".group-head") : null;
        const section = head && head.closest(".group");
        const key = section && section.dataset.group;
        if (key && key !== opts.selfGroup && !section.classList.contains("handoff-zone")) {
          head.classList.add("drag-target");
          hit = { id: opts.idOf(row), reassignGroup: key };
          return;
        }
      }
      const list = opts.list();
      if (!list) return;
      const items = [...list.children].filter((el) => el !== row && opts.accept(el));
      // 捆一捆（设定15）：压在别条的正中间（上下各留 30% 给插缝）＝捆上；学手机桌面把图标叠一起建文件夹。
      if (opts.bundleable) {
        for (const item of items) {
          const r = item.getBoundingClientRect();
          if (y > r.top + r.height * 0.3 && y < r.bottom - r.height * 0.3 && x >= r.left && x <= r.right) {
            item.classList.add("bundle-target");
            hit = { id: opts.idOf(row), bundleWith: opts.idOf(item) };
            return;
          }
        }
      }
      let anchor = null;
      let place = "below";
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          anchor = item;
          place = "above";
          break;
        }
      }
      if (!anchor && items.length) {
        anchor = items[items.length - 1];
        place = "below";
      }
      if (!anchor) return;
      anchor.classList.add(place === "above" ? "gap-above" : "gap-below");
      const anchorId = opts.idOf(anchor);
      const id = opts.idOf(row);
      if (!anchorId || anchorId === id) return;
      hit = { id, anchorId, place };
    }
    function onMove(event) {
      lastX = event.clientX;
      lastY = event.clientY;
      if (!armed) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) <= BM_DRAG_SLOP) return;
        arm();
        if (!armed) return;
      }
      event.preventDefault();
      paint(event.clientX, event.clientY);
    }
    function onUp() { finish(true); }
    function onCancel() { finish(false); }
    // 挂在整个窗口上：按着的那条哪怕被换掉，松手也收得到。
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
  handle.addEventListener("click", (event) => {
    if (row.dataset.swallow !== "1") return;
    event.preventDefault();
    event.stopPropagation();
    delete row.dataset.swallow;
  }, true);
}

function bmDragScroll(y) {
  const board = document.getElementById("board");
  if (!board) return;
  const rect = board.getBoundingClientRect();
  if (y < rect.top + 40) board.scrollTop -= 14;
  else if (y > rect.bottom - 40) board.scrollTop += 14;
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
  head.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void bmBeginInsert(key, null, "above");
  });

  const dot = document.createElement("span");
  dot.className = "dot";
  const logo = key === BM_INBOX_KEY ? null : bmLogoKey(displayName);
  if (logo) {
    dot.classList.add("logo");
    dot.dataset.logo = logo;
    dot.innerHTML = BM_LOGOS[logo];
  } else {
    dot.style.background = key === BM_INBOX_KEY ? "#b9c4a6" : bmDotColor(displayName);
  }
  head.appendChild(dot);

  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = displayName;
  head.appendChild(name);

  // 组名后面不放条数、不放折叠钮（2026-09-24 用户：条数没用，组高度跟着内容自己撑开缩回）；
  // 也不放小加号：第一格永远是空白框，点进去就写（2026-09-24 用户：不用再按加号）。
  group.appendChild(head);

  if (bmOpenComposerGroup === key) group.appendChild(bmBuildComposer(key, displayName));

  const list = document.createElement("ul");
  list.className = "task-list";
  bmFillTaskList(list, records, key);
  if (list.childElementCount) group.appendChild(list);
  return group;
}

function bmBuildTask(record, groupKey, order) {
  const item = document.createElement("li");
  item.className = "task";
  if (record.kind === "handoff") item.classList.add("handoff"); // 交接单：显眼样式（📋 标记+淡黄底），一眼认出
  item.dataset.id = record.id;
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const rect = item.getBoundingClientRect();
    const place = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
    bmShowCtxMenu(record, groupKey, item, place);
  });

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "handle";
  handle.title = "点开菜单";
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
  if (bmEditingId === record.id) {
    const input = document.createElement("textarea");
    input.className = "task-edit";
    input.value = record.text;
    input.addEventListener("input", () => {
      bmFitTextarea(input);
      bmScheduleEditSave(record.id, input);
    });
    input.addEventListener("compositionend", () => bmScheduleEditSave(record.id, input));
    input.addEventListener("blur", () => { if (!bmRepainting && !bmImagesBusy) void bmEditCommit(record.id, input, true); });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void bmEditCommit(record.id, input, true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (bmEditSaveTimer) window.clearTimeout(bmEditSaveTimer);
        bmEditingId = null;
        bmRenderCurrent();
      }
    });
    body.appendChild(input);
    bmBindImageEditor(input);
  } else {
    const text = document.createElement("div");
    text.className = "task-text";
    bmRenderImages(text, record.text, false, record.attachments || []);
    // 单击就改字；按下挪了算拖（bmBindDrag），拖完那一下点击会被吞掉，不会误进改字。
    text.addEventListener("click", (event) => {
      event.stopPropagation();
      void bmBeginEdit(record.id);
    });
    body.appendChild(text);
  }
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
  // 睡觉档干完待审（设定18）：AI 的大白话报告挂在条目下面，用户早上看，点「可以，删掉」才删。
  if (record.report) {
    item.classList.add("reported");
    const box = document.createElement("div");
    box.className = "task-report";
    const head = document.createElement("div");
    head.className = "report-head";
    head.textContent = `✅ 干完待审 · ${record.reportedBy ?? ""} · ${bmClock(Date.parse(record.reportedAt))}`;
    const words = document.createElement("div");
    words.className = "report-text";
    words.textContent = record.report;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "report-ok";
    ok.textContent = "可以，删掉";
    ok.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await window.bookmark.remove(record.id);
        bmToast("审过了，这条删掉了");
        void bmRefresh();
      } catch (error) {
        bmShowError(bmErrorText(error));
      }
    });
    box.append(head, words, ok);
    body.appendChild(box);
  }
  item.appendChild(body);
  // 在干标记（设定15）：哪个 AI 窗口领走了，一眼看到；别的窗口领不走。
  if (record.claimedBy) {
    item.classList.add("claimed");
    const claim = document.createElement("span");
    claim.className = "claim";
    claim.textContent = `🔄 ${record.claimedBy} 在干`;
    item.appendChild(claim);
  }
  // 行尾复制（2026-09-24 用户拍板：给他自己用，拿去别处商量；常显、平时淡一点）：点一下就复制这条的文字。
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "t-copy";
  copy.title = "复制这条";
  copy.innerHTML = bmIcon("copy");
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await window.bookmark.copyForAgent(record.id, null);
      bmToast("已复制这条");
    } catch (error) {
      bmShowError(bmErrorText(error));
    }
  });
  item.appendChild(copy);
  bmBindDrag({
    handle: item,
    row: item,
    selfGroup: groupKey,
    reassign: true,
    bundleable: bmAgents.includes(groupKey),
    list: () => item.parentElement,
    accept: (el) => el.classList.contains("task"),
    idOf: (el) => el.dataset.id || "",
    onDrop: async (hit) => {
      if (hit.reassignGroup !== undefined) {
        const assignee = hit.reassignGroup === BM_INBOX_KEY ? null : hit.reassignGroup;
        await bmReassign(hit.id, assignee);
        return;
      }
      if (hit.bundleWith) {
        try {
          await window.bookmark.bundle(hit.id, hit.bundleWith);
        } catch (error) {
          bmShowError(bmErrorText(error));
        }
        await bmRefresh();
        return;
      }
      if (!hit.anchorId || hit.anchorId === hit.id) return;
      await window.bookmark.move(hit.id, hit.anchorId, hit.place);
      await bmRefresh();
    },
  });
  return item;
}

function bmRenderCurrent() {
  // 重画当前页（重新拉库；拖动中会被 bmDragActive 压住，松手补画）。
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

  // 同款小加号：自己也能手写一张交接单（2026-09-24 用户要）
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "g-add";
  addBtn.title = "手写一张交接单";
  addBtn.innerHTML = bmIcon("plus");
  addBtn.addEventListener("click", () => { void bmBeginInsert(BM_HANDOFF_ZONE_KEY, null, "above", "handoff"); });
  head.appendChild(addBtn);

  head.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void bmBeginInsert(BM_HANDOFF_ZONE_KEY, null, "above", "handoff");
  });
  group.appendChild(head);

  const list = document.createElement("ul");
  list.className = "task-list";
  bmFillTaskList(list, records, BM_HANDOFF_ZONE_KEY);
  if (list.childElementCount) group.appendChild(list);
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
  const rows = listing.ordered && listing.ordered.length ? listing.ordered : listing.dirs.concat(listing.files);
  for (const entry of rows) list.appendChild(bmBuildProjectRow(entry));
  board.appendChild(list);
}

/** 单行：文件夹（单击进入+悬停自动弹目录预览）/ md（单击系统默认程序打开）；按下直接挪=拖动排序。 */
function bmBuildProjectRow(entry) {
  const row = document.createElement("li");
  row.className = "proj-row" + (entry.isDir ? " is-dir" : " is-file");
  row.dataset.rel = entry.relPath;
  row.dataset.name = entry.name;

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
  bmBindDrag({
    handle: row,
    row,
    list: () => row.parentElement,
    accept: (el) => el.classList.contains("proj-row"),
    idOf: (el) => el.dataset.name || "",
    onDrop: async (hit) => {
      if (!hit.anchorId || hit.anchorId === hit.id) return;
      await window.bookmark.projectsReorder(bmProjectsCwd, hit.id, hit.anchorId, hit.place);
      await bmRenderProjects();
    },
  });
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
  const hadFocus = opts.input ? bmEditorHasFocus(opts.input) : false;
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

function bmFillTaskList(list, records, groupKey) {
  const draft = bmInsertDraft && bmInsertDraft.groupKey === groupKey ? bmInsertDraft : null;
  const anchored = Boolean(draft && draft.anchorId && records.some((record) => record.id === draft.anchorId));
  if (draft && !anchored) draft.anchorId = null; // 锚点那条没了 → 当成写在最上面
  // 第一格永远是空白框（交接单专区除外，它还是点小加号才冒输入行）；写在最上面的草稿就写在这个框里。
  if (groupKey !== BM_HANDOFF_ZONE_KEY) list.appendChild(bmBuildInsertRow(groupKey, true));
  else if (draft && !anchored) list.appendChild(bmBuildInsertRow(groupKey, false));
  records.forEach((record, index) => {
    const prevBundle = index > 0 ? records[index - 1].bundleId : null;
    const nextBundle = index < records.length - 1 ? records[index + 1].bundleId : null;
    if (record.bundleId && record.bundleId !== prevBundle) {
      list.appendChild(bmBuildBundleHead(record.bundleId, records.filter((r) => r.bundleId === record.bundleId), groupKey));
    }
    if (draft && anchored && draft.anchorId === record.id && draft.place === "above") list.appendChild(bmBuildInsertRow(groupKey, false));
    const task = bmBuildTask(record, groupKey, index + 1);
    if (record.bundleId) {
      task.classList.add("in-bundle");
      if (record.bundleId !== nextBundle) task.classList.add("bundle-last");
    }
    list.appendChild(task);
    if (draft && anchored && draft.anchorId === record.id && draft.place === "below") list.appendChild(bmBuildInsertRow(groupKey, false));
  });
}

function bmFitTextarea(input) {
  input.style.height = "auto";
  input.style.height = Math.max(input.scrollHeight, 22) + "px";
}

async function bmBeginInsert(groupKey, anchorId, place, kind) {
  if (bmImagesBusy) return;
  bmInsertDraft = {
    groupKey,
    anchorId: anchorId || null,
    place: place === "below" ? "below" : "above",
    id: null,
    text: "",
    kind: kind || (groupKey === BM_HANDOFF_ZONE_KEY ? "handoff" : "note"),
  };
  bmEditingId = null;
  // 等框画出来再放光标：光标不在框里，点别处就没有「离开」这回事，框收不起来（2026-09-24 修）。
  await bmRefresh();
  const input = bmFindInsertInput(groupKey, !bmInsertDraft || !bmInsertDraft.anchorId);
  if (!input) return;
  input.focus();
  bmFitTextarea(input);
}

/** 某组里的输入框：blank＝第一格那个空白框（交接单专区没有空白框，就是它最上面冒出来的输入行），否则＝右键插进来的那行。 */
function bmFindInsertInput(groupKey, blank) {
  const group = [...document.querySelectorAll("#board .group")].find((el) => el.dataset.group === groupKey);
  if (!group) return null;
  return group.querySelector(blank ? ".insert-row textarea" : ".insert-row:not(.blank-row) textarea");
}

/**
 * 输入行。blank＝每组第一格那个常驻空白框（2026-09-24 用户：不用再按加号）：点进去写，第一个字起开一份草稿、
 * 边写边存；回车或点别处＝这条落到第二格，框清空（回车后光标留在框里接着写）。非 blank＝右键插进来 / 交接单专区的那行。
 */
function bmBuildInsertRow(groupKey, blank) {
  const item = document.createElement("li");
  // 空白框不算条目（不带 task）：拖动、数条目、「第一条」都不许把它算进去。
  item.className = blank ? "insert-row blank-row" : "task insert-row";
  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = blank ? "写一条…" : "写在这，写了就存";
  // 这个框是不是正在写的那份草稿：空白框只认写在最上面的草稿，右键那行认本组的草稿。
  const mine = () => Boolean(bmInsertDraft && bmInsertDraft.groupKey === groupKey && (!blank || !bmInsertDraft.anchorId));
  input.value = mine() ? bmInsertDraft.text : "";
  input.addEventListener("input", () => {
    if (!mine()) {
      if (!blank) return;
      bmInsertDraft = { groupKey, anchorId: null, place: "above", id: null, text: "", kind: "note" };
    }
    bmInsertDraft.text = input.value;
    bmFitTextarea(input);
    if (input.isComposing) return;
    bmScheduleInsertSave(input);
  });
  input.addEventListener("compositionend", () => { if (mine()) bmScheduleInsertSave(input); });
  input.addEventListener("blur", () => { if (!bmRepainting && !bmImagesBusy && mine()) void bmInsertCommit({ close: true, input }); });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Escape") {
      event.preventDefault();
      if (mine()) void bmInsertCommit({ close: true, input });
    }
  });
  item.appendChild(input);
  bmBindImageEditor(input);
  return item;
}

function bmScheduleInsertSave(input) {
  if (bmInsertSaveTimer) window.clearTimeout(bmInsertSaveTimer);
  bmInsertSaveTimer = window.setTimeout(() => {
    bmInsertSaveTimer = null;
    void bmInsertCommit({ input });
  }, 400);
}

async function bmInsertCommit(opts = {}) {
  if (bmImagesBusy) return;
  const draft = bmInsertDraft;
  if (!draft) return;
  if (bmInsertSaveTimer) {
    window.clearTimeout(bmInsertSaveTimer);
    bmInsertSaveTimer = null;
  }
  const text = String(draft.text ?? "").trim();
  const hadFocus = Boolean(opts.input && bmEditorHasFocus(opts.input));
  const caret = hadFocus && opts.input ? opts.input.selectionStart : null;
  try {
    if (!text) {
      if (draft.id) await window.bookmark.remove(draft.id);
      draft.id = null;
    } else if (draft.id) {
      const url = bmDetectUrl(text);
      const body = url ? (text.replace(url, "").trim() || url) : text;
      await window.bookmark.updateText(draft.id, body, url);
    } else {
      const url = bmDetectUrl(text);
      const body = url ? (text.replace(url, "").trim() || url) : text;
      const assignee = draft.groupKey === BM_INBOX_KEY || draft.groupKey === BM_HANDOFF_ZONE_KEY
        ? null
        : (bmAgents.find((name) => name === draft.groupKey) ?? null);
      const record = await window.bookmark.insertBeside({
        anchorId: draft.anchorId,
        place: draft.place,
        text: body,
        url,
        assignee,
        kind: draft.kind,
      });
      draft.id = record.id;
    }
  } catch (error) {
    bmShowError("自动存档失败： " + bmErrorText(error));
    return;
  }
  if (opts.close) {
    // 等存档那会儿用户可能已经在别的框开了新草稿，别把人家的冲掉
    if (bmInsertDraft === draft) bmInsertDraft = null;
    await bmRefresh();
    return;
  }
  await bmRefresh();
  if (!hadFocus) return;
  const input = bmFindInsertInput(draft.groupKey, !draft.anchorId);
  if (!input) return;
  input.focus();
  const at = typeof caret === "number" ? caret : input.value.length;
  input.setSelectionRange(at, at);
  bmFitTextarea(input);
}

async function bmBeginEdit(id) {
  if (bmImagesBusy) return;
  bmEditingId = id;
  bmInsertDraft = null;
  await bmRefresh(); // 同 bmBeginInsert：等框画出来再放光标
  const input = document.querySelector(".task-edit");
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  bmFitTextarea(input);
}

function bmScheduleEditSave(id, input) {
  if (bmEditSaveTimer) window.clearTimeout(bmEditSaveTimer);
  bmEditSaveTimer = window.setTimeout(() => {
    bmEditSaveTimer = null;
    void bmEditCommit(id, input, false);
  }, 400);
}

async function bmEditCommit(id, input, close) {
  if (bmImagesBusy) return;
  if (bmEditingId !== id && close) return;
  if (bmEditSaveTimer) {
    window.clearTimeout(bmEditSaveTimer);
    bmEditSaveTimer = null;
  }
  const text = String(input?.value ?? "").trim();
  const hadFocus = bmEditorHasFocus(input);
  const caret = hadFocus ? input.selectionStart : null;
  try {
    if (!text) await window.bookmark.remove(id);
    else {
      const url = bmDetectUrl(text);
      const body = url ? (text.replace(url, "").trim() || url) : text;
      await window.bookmark.updateText(id, body, url);
    }
  } catch (error) {
    bmShowError("自动存档失败： " + bmErrorText(error));
    return;
  }
  if (close || !text) {
    if (bmEditingId === id) bmEditingId = null;
    await bmRefresh();
    return;
  }
  await bmRefresh();
  if (!hadFocus) return;
  const next = document.querySelector(".task-edit");
  if (!next) return;
  next.focus();
  const at = typeof caret === "number" ? caret : next.value.length;
  next.setSelectionRange(at, at);
  bmFitTextarea(next);
}

function bmShowCtxMenu(record, groupKey, anchor, insertPlace) {
  const menu = document.getElementById("ctx-menu");
  menu.textContent = "";

  // 左边六个点管「交给 AI 干活」（2026-09-24 用户拍板）：只在 agent 组里出现；待定是还在商量，不启动。
  const copyOptions = bmAgents.includes(groupKey) ? bmLaunchOptions(record.id, groupKey) : [];
  for (const el of copyOptions) menu.appendChild(el);
  if (record.claimedBy) menu.appendChild(bmReleaseItem(record));
  if (copyOptions.length || record.claimedBy) {
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    menu.appendChild(sep);
  }

  if (insertPlace) {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "ctx-item";
    create.textContent = "新建";
    create.addEventListener("click", () => {
      bmHideCtxMenu();
      const kind = groupKey === BM_HANDOFF_ZONE_KEY ? "handoff" : "note";
      void bmBeginInsert(groupKey, record.id, insertPlace, kind);
    });
    menu.appendChild(create);
  }

  // 「派给 →」只在待定页给（2026-09-24 用户拍板：分组页拖到组头就是派给谁，菜单再列一遍是重复）。
  // 待定页跟分组不在同一页、拖不过去，只能靠这里；「收回」也拖不回去（待定、专区都不是拖放目标），下面留着。
  const targets = groupKey === BM_INBOX_KEY ? bmAgents : [];
  if (groupKey === BM_INBOX_KEY) {
    const title = document.createElement("div");
    title.className = "ctx-title";
    title.textContent = "派给 →";
    menu.appendChild(title);
    if (!targets.length) {
      const none = document.createElement("div");
      none.className = "ctx-none";
      none.textContent = "（还没有分组）";
      menu.appendChild(none);
    }
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
  const menuHeightEstimate = 40 + (targets.length + copyOptions.length) * 30 + 70;
  let left = rect.right - panelRect.left + 6;
  if (left + menuWidth > panelRect.width) left = rect.left - panelRect.left - menuWidth - 6;
  let top = rect.top - panelRect.top;
  if (top + menuHeightEstimate > panelRect.height) top = Math.max(8, panelRect.height - menuHeightEstimate - 8);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
}

// ── 交给 AI 干活（2026-09-24 设定15）：启动 Agent / 放回去 / 捆头 ──────────────────
// 启动 Agent：看板给这个窗口起名（Claude-3），把一句「领看板的活：node … next <捆或条> --by Claude-3」放进剪贴板，
// 用户开窗 Ctrl+V、自己按回车；AI 敲了这句才算领走（看板上出「🔄 Claude-3 在干」）。🚨 看板绝不替他发。

function bmLaunchOptions(target, groupKey) {
  return [
    { label: "启动 Agent · 带编程", coding: true },
    { label: "启动 Agent · 普通", coding: false },
  ].map((opt) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ctx-item";
    item.textContent = opt.label;
    item.addEventListener("click", async () => {
      bmHideCtxMenu();
      try {
        const res = await window.bookmark.launchLine(target, groupKey, opt.coding);
        if (res.opened && res.pasting) {
          const how = res.freshWindow ? "把启动句贴进去" : "新开一个对话、把启动句贴进去";
          bmToast(`已打开「${res.opened}」（${res.label}）：等它启动好，看板替你${how}，你看一眼再按回车`, 8000);
        } else if (res.opened) {
          const where = res.freshWindow ? "等新窗口出来" : "在里面新开一个对话";
          bmToast(`已打开「${res.opened}」，启动句已复制（${res.label}）：${where}，Ctrl+V 再回车`, 6000);
        } else {
          const why = res.problem ? `${res.problem}。` : "";
          bmToast(`${why}启动句已复制（${res.label}）：开一个新的 ${groupKey} 窗口，Ctrl+V 再回车`, 6000);
        }
      } catch (error) {
        bmShowError(bmErrorText(error));
      }
    });
    return item;
  });
}

function bmReleaseItem(record) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "ctx-item back";
  item.textContent = `放回去（${record.claimedBy} 不干了）`;
  item.addEventListener("click", async () => {
    bmHideCtxMenu();
    try {
      await window.bookmark.release(record.id);
      await bmRefresh();
    } catch (error) {
      bmShowError(bmErrorText(error));
    }
  });
  return item;
}

/** 捆头：六个点（整捆启动 Agent / 拆开）+ 名字（第一条开头几个字）+ 谁在干。 */
function bmBuildBundleHead(bundleId, members, groupKey) {
  const head = document.createElement("li");
  head.className = "bundle-head";
  head.dataset.bundle = bundleId;
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "handle";
  handle.title = "这一捆：启动 Agent / 拆开";
  handle.textContent = "⠿";
  const openMenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    bmShowBundleMenu(bundleId, groupKey, handle);
  };
  handle.addEventListener("click", openMenu);
  head.addEventListener("contextmenu", openMenu);
  head.appendChild(handle);
  const name = document.createElement("span");
  name.className = "bundle-name";
  const first = members[0] ? members[0].text : "";
  name.textContent = first.length > 16 ? `${first.slice(0, 16)}…` : first;
  head.appendChild(name);
  const busy = [...new Set(members.map((r) => r.claimedBy).filter(Boolean))];
  if (busy.length) {
    const claim = document.createElement("span");
    claim.className = "claim";
    claim.textContent = `🔄 ${busy.join("、")} 在干`;
    head.appendChild(claim);
  }
  return head;
}

function bmShowBundleMenu(bundleId, groupKey, anchor) {
  const menu = document.getElementById("ctx-menu");
  menu.textContent = "";
  for (const el of bmLaunchOptions(bundleId, groupKey)) menu.appendChild(el);
  const sep = document.createElement("div");
  sep.className = "ctx-sep";
  menu.appendChild(sep);
  const split = document.createElement("button");
  split.type = "button";
  split.className = "ctx-item";
  split.textContent = "拆开这一捆";
  split.addEventListener("click", async () => {
    bmHideCtxMenu();
    await window.bookmark.unbundle(bundleId);
    await bmRefresh();
  });
  menu.appendChild(split);
  menu.hidden = false;
  const panelRect = document.getElementById("app").getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(rect.right - panelRect.left + 6, panelRect.width - 174))}px`;
  menu.style.top = `${Math.max(6, Math.min(rect.top - panelRect.top, panelRect.height - 150))}px`;
}

/** 设置浮层加一行：要求模板（带编程.md 等）在哪改。 */
function bmAddTemplatesSettingRow() {
  const pop = document.getElementById("settings-popover");
  if (!pop || pop.querySelector(".settings-templates")) return;
  const row = document.createElement("div");
  row.className = "settings-row settings-templates";
  const label = document.createElement("span");
  label.className = "settings-label";
  label.textContent = "要求模板";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-open-btn";
  btn.textContent = "打开文件夹";
  btn.title = "「启动 Agent · 带编程」用的是里面的 带编程.md，改这个文件就改了要求";
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    window.bookmark.openTemplates().catch((error) => bmShowError(bmErrorText(error)));
  });
  row.appendChild(label);
  row.appendChild(btn);
  pop.appendChild(row);
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
