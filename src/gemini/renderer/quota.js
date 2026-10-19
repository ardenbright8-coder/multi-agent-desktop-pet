// 只读提示球；没有按钮、图表和登录控件。整窗由主进程设置鼠标穿透。
function gqElement(tag, className, value) { const e=document.createElement(tag); e.className=className; if(value!==undefined)e.textContent=value; return e; }
async function gqRender() {
  try {
    const {accounts}=await window.geminiQuota.get();
    const root=document.getElementById('bubbles'); root.replaceChildren();
    for(const row of accounts) {
      const el=gqElement('section','quota-bubble'+(row.stale?' old':'')); el.dataset.accountId=row.accountId;
      const line=gqElement('div','line');
      line.append(gqElement('span','account',row.label),gqElement('span','amount','5h 已用 '+row.current.used+'%'));
      const reset=gqElement('div','reset'); reset.append(gqElement('i','dot'),document.createTextNode((row.stale?'上次 · ':'')+'重置 '+(row.current.reset.raw||'未提供')));
      el.append(line,reset);
      el.title=row.label+' · 5小时已用 '+row.current.used+'%\n官网重置原文：'+(row.current.reset.raw||'未提供')+'\n读取：'+new Date(row.observedAt).toLocaleTimeString()+(row.stale?'（旧数）':'')+(row.weekly?'\n本周已用 '+row.weekly.used+'%':'');
      root.append(el);
    }
  } catch { /* 桌宠退出时不弹错误、不抢焦点 */ }
}
void gqRender(); setInterval(gqRender,2000);
