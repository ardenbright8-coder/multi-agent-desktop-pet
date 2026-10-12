// 看板派工界面：Ctrl 点选任务、右键「捆成一捆」、技能查看。只生成领取命令，不开助手窗口。
// 2026-10-12 用户拍板（设定21）：顶上那条「已选 N 条 / 捆名 / 多人派工」工具栏撤掉，改成选中后右键弹菜单；
// 以最后一次为准——选中的条目原来在别的捆里，就从原捆拿出来进新捆。多人派工捆照旧走命令行 dispatch bundle。
const bmSelectedTasks = new Set();
let bmSelectedGroup = null;
let bmDispatchRecords = [];
let bmDispatchBundles = new Map();
let bmSkillRenderGeneration = 0;

function bmRefreshDispatchSelection() {
  const ids = new Set(bmDispatchRecords.map(r => r.id));
  for (const id of bmSelectedTasks) if (!ids.has(id)) bmSelectedTasks.delete(id);
  if (!bmSelectedTasks.size || bmCurrentPage !== 'groups') { bmSelectedTasks.clear(); bmSelectedGroup = null; }
  document.querySelectorAll('.task[data-id]').forEach(el => {
    el.classList.toggle('dispatch-selected', bmSelectedTasks.has(el.dataset.id));
    el.setAttribute('aria-selected', String(bmSelectedTasks.has(el.dataset.id)));
  });
}
function bmClearDispatchSelection() {
  bmSelectedTasks.clear();
  bmSelectedGroup = null;
  bmRefreshDispatchSelection();
}
function bmInitDispatch() {
  document.addEventListener('pointerdown', event => {
    if ((event.ctrlKey || event.metaKey) && event.target.closest('.task') && !event.target.closest('textarea,input,.bm-rich-input,button,a')) event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', event => {
    if (!(event.ctrlKey || event.metaKey) || event.target.closest('textarea,input,.bm-rich-input,button,a')) return;
    const row = event.target.closest('.task[data-id]');
    if (!row || bmCurrentPage !== 'groups') return;
    const record = bmDispatchRecords.find(r => r.id === row.dataset.id);
    const group = row.closest('.group')?.dataset.group ?? null;
    if (!record || !group) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (bmSelectedTasks.size && bmSelectedGroup !== group) {
      bmToast('一次只选同一个分组的；先捆好这一批再选下一批');
      return;
    }
    if (record.claimedBy || record.report || bmDispatchBundles.has(record.bundleId)) {
      bmToast('这条在干、待审核或在多人派工捆里，先放回再捆');
      return;
    }
    if (bmSelectedTasks.has(record.id)) bmSelectedTasks.delete(record.id);
    else bmSelectedTasks.add(record.id);
    bmSelectedGroup = bmSelectedTasks.size ? group : null;
    bmRefreshDispatchSelection();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') bmClearDispatchSelection();
  });
}

/** 选中两条以上、在选中的条目上右键：弹「捆成一捆」（菜单以后往这里加项）。 */
function bmShowSelectionMenu(anchor, clientY) {
  const menu = document.getElementById('ctx-menu');
  menu.textContent = '';
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = `已选 ${bmSelectedTasks.size} 条`;
  menu.appendChild(title);
  const name = document.createElement('input');
  name.className = 'ctx-input';
  name.placeholder = '捆名（可不填）';
  name.setAttribute('aria-label', '捆名');
  name.maxLength = 24;
  menu.appendChild(name);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'ctx-item';
  go.textContent = '捆成一捆';
  const submit = async () => {
    try {
      await window.bookmark.bundleSelected([...bmSelectedTasks], name.value.trim());
      bmHideCtxMenu();
      bmClearDispatchSelection();
      await bmRefresh();
    } catch (e) { bmShowError(bmErrorText(e)); }
  };
  go.addEventListener('click', () => { void submit(); });
  name.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); void submit(); }
    if (event.key === 'Escape') bmHideCtxMenu();
  });
  menu.appendChild(go);
  menu.hidden = false;
  const panelRect = document.getElementById('app').getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const y = typeof clientY === 'number' ? clientY : rect.top;
  menu.style.left = `${Math.max(6, Math.min(rect.left - panelRect.left + 40, panelRect.width - 174))}px`;
  menu.style.top = `${Math.max(6, Math.min(y - panelRect.top, panelRect.height - 130))}px`;
}

function bmShowDispatchBundleMenu(bundle, menu) {
  const label = document.createElement('div');
  label.className = 'dispatch-menu-info';
  label.textContent = `${bundle.name} · ${bundle.owner ? `${bundle.owner} 占住整捆` : '待领取'} · 报告交给 ${bundle.coordinator}`;
  menu.appendChild(label);
  const worker = document.createElement('input');
  worker.className = 'dispatch-worker';
  worker.setAttribute('aria-label', '执行窗口名');
  worker.placeholder = '执行窗口名';
  worker.value = bundle.owner || `工兵-${Date.now().toString(36)}`;
  menu.appendChild(worker);
  const copy = document.createElement('button');
  copy.className = 'ctx-item';
  copy.textContent = bundle.owner ? '复制原窗口继续领取命令' : '复制领活命令（自己开窗口）';
  copy.addEventListener('click', async () => {
    try {
      await window.bookmark.copyDispatch(bundle.id, worker.value);
      bmToast('已复制：自己打开执行窗口，粘贴命令；看板没有开新窗口', 7000);
      bmHideCtxMenu();
    } catch (e) { bmShowError(bmErrorText(e)); }
  });
  menu.appendChild(copy);
  if (bundle.status === '待审核') {
    const accept = document.createElement('button');
    accept.className = 'ctx-item';
    accept.textContent = '测试通过后清理这一捆';
    let confirmed = false;
    accept.addEventListener('click', async () => {
      if (!confirmed) { confirmed = true; accept.textContent = '确认已测试通过，删除本捆任务'; return; }
      try {
        await window.bookmark.dispatch({ action: 'accept', target: bundle.id, by: bundle.coordinator,
          ok: '用户在看板亲自点击确认已测试通过，删除本捆任务' });
        bmHideCtxMenu();
        await bmRefresh();
      } catch (e) { bmShowError(bmErrorText(e)); }
    });
    menu.appendChild(accept);
  }
  if (bundle.owner) {
    const release = document.createElement('button');
    release.className = 'ctx-item';
    release.textContent = '放回整捆（先停原工兵）';
    let confirmed = false;
    release.addEventListener('click', async () => {
      if (!confirmed) { confirmed = true; release.textContent = '确认原工兵已停止，再点放回'; return; }
      try {
        await window.bookmark.dispatch({ action: 'release', target: bundle.id, by: bundle.coordinator });
        bmHideCtxMenu();
        await bmRefresh();
      } catch (e) { bmShowError(bmErrorText(e)); }
    });
    menu.appendChild(release);
  }
}

async function bmRenderSkills() {
  const generation = ++bmSkillRenderGeneration;
  const board = document.getElementById('board');
  try {
    const skills = await window.bookmark.boardSkills();
    if (generation !== bmSkillRenderGeneration || bmCurrentPage !== 'skills') return;
    board.textContent = '';
    const intro = document.createElement('p');
    intro.className = 'dispatch-intro';
    intro.textContent = '这里是看板技能正本：你可以看完整规则，助手也读取同一份文件。查看不会启动助手或执行代码。';
    board.appendChild(intro);
    for (const skill of skills) {
      const card = document.createElement('section');
      card.className = 'group skill-card';
      const title = document.createElement('h3'); title.textContent = skill.name;
      const desc = document.createElement('p');
      const summary = skill.description.split('。')[0];
      desc.textContent = summary.length > 130 ? `${summary.slice(0, 130)}…` : `${summary}。`;
      const path = document.createElement('p'); path.className = 'skill-path'; path.textContent = skill.path;
      const open = document.createElement('button'); open.textContent = '查看完整规则';
      const content = document.createElement('pre'); content.className = 'skill-content'; content.hidden = true;
      open.addEventListener('click', async () => {
        try {
          const data = await window.bookmark.readBoardSkill(skill.name);
          content.textContent = data.text;
          content.hidden = !content.hidden;
          open.textContent = content.hidden ? '查看完整规则' : '收起规则';
        } catch (e) { bmShowError(bmErrorText(e)); }
      });
      card.append(title, desc, path, open, content); board.appendChild(card);
    }
    if (!skills.length) intro.textContent += ' 当前没有技能文件。';
  } catch (e) { if (bmCurrentPage === 'skills') bmShowError(bmErrorText(e)); }
}
