// 看板派工界面：Ctrl选任务、两种成捆、技能查看。只生成领取命令，不开助手窗口。
const bmSelectedTasks = new Set();
let bmDispatchRecords = [];
let bmDispatchBundles = new Map();
let bmSkillRenderGeneration = 0;

function bmRefreshDispatchSelection() {
  const ids = new Set(bmDispatchRecords.map(r => r.id));
  for (const id of bmSelectedTasks) if (!ids.has(id)) bmSelectedTasks.delete(id);
  document.querySelectorAll('.task[data-id]').forEach(el => {
    el.classList.toggle('dispatch-selected', bmSelectedTasks.has(el.dataset.id));
    el.setAttribute('aria-selected', String(bmSelectedTasks.has(el.dataset.id)));
  });
  const toolbar = document.getElementById('dispatch-toolbar');
  toolbar.hidden = !bmSelectedTasks.size || bmCurrentPage !== 'groups';
  document.getElementById('dispatch-selected-count').textContent = `已选 ${bmSelectedTasks.size} 条`;
}
function bmClearDispatchSelection() {
  bmSelectedTasks.clear();
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
    if (!record || record.kind === 'handoff' || !record.assignee) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selected = bmDispatchRecords.find(r => bmSelectedTasks.has(r.id));
    if (selected && selected.assignee.toLowerCase() !== record.assignee.toLowerCase()) {
      bmToast('一次只选同一个助手分组的任务；先捆好这一批再选下一批');
      return;
    }
    if (record.claimedBy || record.report || record.bundleId) {
      bmToast('这条已在捆里、在干或待审核；先放回或拆开原捆');
      return;
    }
    if (bmSelectedTasks.has(record.id)) bmSelectedTasks.delete(record.id);
    else bmSelectedTasks.add(record.id);
    bmRefreshDispatchSelection();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') bmClearDispatchSelection();
  });
  document.getElementById('dispatch-clear').addEventListener('click', bmClearDispatchSelection);
  document.getElementById('dispatch-create').addEventListener('click', async () => {
    try {
      const coop = document.getElementById('dispatch-cooperate').checked;
      const coordinator = document.getElementById('dispatch-coordinator').value.trim();
      if (coop && !coordinator) throw new Error('填写调度窗口名；任务报告会留给这个名字对应的调度者');
      const reply = await window.bookmark.dispatch({ action: 'bundle', ids: [...bmSelectedTasks],
        name: document.getElementById('dispatch-name').value.trim(), coordinator: coop ? coordinator : undefined });
      bmClearDispatchSelection();
      document.getElementById('dispatch-name').value = '';
      await bmRefresh();
      bmToast(`已生成${coop ? '多人派工捆' : '普通捆'}：${reply.bundle.name}。继续选另一批可生成第二捆`, 5000);
    } catch (e) { bmShowError(bmErrorText(e)); }
  });
  document.getElementById('dispatch-cooperate').addEventListener('change', event => {
    document.getElementById('dispatch-coordinator').hidden = !event.target.checked;
  });
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
