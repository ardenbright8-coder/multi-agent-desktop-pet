// 采集器离线验证：所有Google网址均本地拦截，不读用户浏览器，不向真实Google发请求。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('E:/个人AI资源管理/60_公用资源（钩子·skill·搜索引擎·可后期扩展）/后台驱动测试（Playwright·零抢鼠标·测Electron应用）/包（npm下载·playwright完整包）/node_modules/playwright');
const core=require('../src/gemini/collector.user.js');
const accountId=core.fingerprint('sample@example.invalid');
const code=readFileSync('src/gemini/collector.user.js','utf8').replace('/*__GEMINI_DESKTOP_BRIDGE__*/null',JSON.stringify({url:'http://127.0.0.1:12345',token:'offline-test-only',serviceId:'offline-test'}));
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
async function setup(monitor){
  const context=await browser.newContext(); let loads=0;
  await context.addInitScript(({accountId,monitor})=>{
    window.testPosts=[]; window.testOpens=[];
    window.GM_getValue=(k,f)=>{if(!monitor&&window.testOpens.length&&k.startsWith('gq:desktop:v1:monitor-alive:'))return Date.now();try{return JSON.parse(localStorage.getItem('test-'+k))??f;}catch{return f;}};
    window.GM_setValue=(k,v)=>localStorage.setItem('test-'+k,JSON.stringify(v));
    window.GM_xmlhttpRequest=o=>{
      if(!o.url.startsWith('http://127.0.0.1:12345/'))throw Error('Unexpected network target');
      queueMicrotask(()=>{
        if(localStorage.getItem('desktop-down')==='1')return o.onload({status:503,responseText:'{}'});
        if(o.url.endsWith('/meta'))return o.onload({status:200,responseText:JSON.stringify({service:'gemini-quota',id:'offline-test'})});
        const body=JSON.parse(o.data); window.testPosts.push(body);o.onload({status:200,responseText:'{"ok":true}'});
      });
    };
    window.GM_openInTab=(url,options)=>{window.testOpens.push({url,options}); window.GM_setValue('gq:desktop:v1:monitor-alive:'+accountId,Date.now());};
  },{accountId,monitor});
  await context.route('**/*',route=>{
    if(route.request().url().endsWith('/collector.user.js'))return route.fulfill({contentType:'application/javascript',body:code});
    loads++;
    const body='<!doctype html><meta charset="utf-8"><a href="https://accounts.google.com/SignOutOptions" aria-label="Google 账号：演示 (sample@example.invalid)">账号</a><main><div>用量限额</div><section><h3>当前用量</h3><p>已使用 13%</p><p>重置时间：8:19</p></section><section><h3>每周限额</h3><p>已使用 40%</p><p>重置时间：10月22日4:19</p></section></main><b id="load-count">'+loads+'</b><script src="/collector.user.js"></script>';
    return route.fulfill({contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':"require-trusted-types-for 'script'; trusted-types 'none'"},body});
  });
  const page=await context.newPage(); await page.clock.install({time:new Date()});
  await page.goto('https://gemini.google.com/u/3/'+(monitor?'usage#gemini-desktop-monitor':'app'));
  await page.clock.fastForward(2000);
  return {context,page,loads:()=>loads};
}
try{
  const a=await setup(false);
  await a.page.waitForFunction(()=>window.testOpens.length===1);
  const opened=await a.page.evaluate(()=>window.testOpens);
  assert.equal(opened[0].options.active,false);assert(opened[0].url.endsWith('/u/3/usage#gemini-desktop-monitor'));
  await a.page.clock.fastForward(11*60000);
  assert.equal(a.loads(),1);assert.equal((await a.page.evaluate(()=>window.testOpens)).length,1);
  assert.equal(await a.page.locator('iframe').count(),0);
  console.log('COLLECTOR_CHAT_OK background-tab/no-chat-reload/no-iframe');
  await a.context.close();
  const b=await setup(true);
  await b.page.waitForFunction(()=>window.testPosts.length>0);
  const payload=await b.page.evaluate(()=>window.testPosts[0]);
  assert.equal(payload.monitor,true);assert.equal(payload.current.used,13);assert.equal(payload.weekly.used,40);assert.equal(payload.accountId,accountId);assert(!JSON.stringify(payload).includes('@'));
  assert.equal((await b.page.evaluate(()=>window.testOpens)).length,0);
  await b.page.clock.fastForward(11*60000);
  await b.page.waitForFunction(()=>document.querySelector('#load-count').textContent==='2');
  assert.equal(b.loads(),2);
  await b.page.evaluate(()=>localStorage.setItem('desktop-down','1'));
  await b.page.clock.fastForward(11*60000);
  assert.equal(b.loads(),2);
  assert.equal(await b.page.locator('#gemini-quota-mini').count(),0);
  console.log('COLLECTOR_MONITOR_OK real-parser/10-minute-reload/stop-when-pet-off/no-email/no-web-bubble/strict-CSP');
  await b.context.close();
}finally{await browser.close();}
