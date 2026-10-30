// ==UserScript==
// @name         Gemini 用量气泡（安静版）
// @namespace    local.gemini-quota-bubble
// @version      3.4.0
// @updateURL    none
// @description  桌宠采集模式：只读官网用量，不在网页显示气泡，不自动聊天，不读取登录凭据。
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      127.0.0.1
// ==/UserScript==
(function () {
    'use strict';
    const BRIDGE = /*__GEMINI_DESKTOP_BRIDGE__*/null;
    const ORIGIN = 'https://gemini.google.com', PERIOD = (typeof window !== 'undefined' && window.testPosts) ? 600000 : 180000;
    const normalize = s => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
    const txt = el => normalize(el?.innerText || el?.textContent);
    const slot = url => new URL(url, ORIGIN).pathname.match(/^\/u\/(\d+)(?:\/|$)/)?.[1] || 'default';
    const isUsage = url => /^\/(?:u\/\d+\/)?usage\/?$/.test(new URL(url, ORIGIN).pathname);
    function fingerprint(s) { let h = 2166136261; for (const c of s.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); }
    function extractTag(label, email) {
        const local = String(email || '').split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 10);
        const m = String(label || '').match(/(?:Google\s*(?:账号|Account)\s*[:：]\s*)([^(\n\r]+?)\s*\(/i);
        const name = m ? normalize(m[1]).replace(/[@()]/g, '').slice(0, 10) : '';
        if (name && !/^(演示|Google|Account|账号)$/i.test(name)) return local ? `${name}·${local.slice(0, 4)}` : name;
        return local;
    }
    function account(doc, url) {
        for (const el of doc.querySelectorAll('a[href*="accounts.google.com/SignOutOptions"],a[aria-label*="Google 账号"],a[aria-label*="Google Account"],button[aria-label*="Google Account"],button[aria-label*="Google 账号"]')) {
            const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + el.textContent;
            const email = label.match(/[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
            if (email) return { id: fingerprint(email), slot: slot(url), tag: extractTag(label, email) };
        }
        return { id: null, slot: slot(url), tag: '' };
    }
    function parsePlan(root) {
        const s = txt(root);
        const tm = s.match(/(?:用量限额|用量限制|使用量限制|Usage limits)\s+(ULTRA|PRO|PLUS|ADVANCED)\b/i)
            || [...root.querySelectorAll('h1,h2,h3,[role="heading"],span,div')].map(el => txt(el)).find(v => /^(ULTRA|PRO|PLUS|ADVANCED)$/i.test(v))?.match(/^(ULTRA|PRO|PLUS|ADVANCED)$/i);
        const tier = tm ? tm[1].toUpperCase() : '';
        if (tier === 'ULTRA') return 'ULTRA · 5倍';
        if (tier === 'PRO' || tier === 'PLUS' || tier === 'ADVANCED') return 'PRO';
        return '普通';
    }
    function percent(s) {
        const m = s.replace(/％/g, '%').match(/(?:已使用|已用|\bused)\s*(\d+(?:\.\d+)?)\s*%/i) || s.match(/(\d+(?:\.\d+)?)\s*%\s*used\b/i);
        const n = m ? Number(m[1]) : NaN; return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
    }
    function card(root, own, other) {
        let best = null;
        const sel = 'h2,h3,h4,[role="heading"],span,p,div,b,strong';
        for (const label of [...root.querySelectorAll(sel)].filter(el => own.test(txt(el)))) {
            for (let el = label, d = 0; el && el !== root.parentElement && d < 8; el = el.parentElement, d++) {
                const s = txt(el); if (s.length > 900) break;
                if ([...el.querySelectorAll(sel)].some(n => other.test(txt(n)))) break;
                const used = percent(s); if (used === null) continue;
                const m = s.match(/(?:重置时间|重設時間|重置于|resets?\s+(?:at|on|in)|reset time)\s*[:：]?\s*([^\n\r]+)/i);
                const raw = m ? normalize(m[1]).slice(0, 96) : '';
                const iso = el.querySelector('time[datetime]')?.getAttribute('datetime') || '';
                const n = /T.*(?:Z|[+-]\d\d:?\d\d)$/i.test(iso) ? Date.parse(iso) : NaN;
                const score = (raw || Number.isFinite(n) ? 1000 : 0) - s.length;
                if (!best || score > best.score) best = { score, used, reset: { raw, epoch: Number.isFinite(n) ? n : null } };
            }
        }
        return best ? { used: best.used, reset: best.reset } : null;
    }
    function parse(doc, url) {
        if (new URL(url, ORIGIN).origin !== ORIGIN || !isUsage(url)) return null;
        if (![...doc.querySelectorAll('h1,h2,h3,[role="heading"],div,span')].some(el => /^(用量限额|用量限制|使用量限制|Usage limits)(\s+(PRO|PLUS|ULTRA))?$/i.test(txt(el)))) return null;
        const root = doc.querySelector('main,[role="main"]') || doc.body;
        const current = card(root, /^(当前用量|目前用量|Current usage|Current limit|Session usage)$/i, /^(每周限额|每周用量|本周用量|Weekly limit|Weekly usage)$/i);
        if (!current) return null;
        return { account: account(doc, url), current,
            weekly: card(root, /^(每周限额|每周用量|本周用量|Weekly limit|Weekly usage)$/i, /^(当前用量|目前用量|Current usage|Current limit|Session usage)$/i),
            plan: parsePlan(root),
            observedAt: Date.now(), sourceUpdated: txt(root).match(/\d+\s*(秒|分钟|小时|天)前更新|刚刚更新|Updated\s+[^\n\r]{1,45}\bago/i)?.[0] || '' };
    }
    if (typeof window === 'undefined' && typeof module === 'object') { module.exports = { account, parse, slot, fingerprint, percent }; return; }
    if (window.self !== window.top || location.origin !== ORIGIN || !BRIDGE) return;
    if (window.__geminiDesktopCollector) return;
    window.__geminiDesktopCollector = true;
    if (location.hash === '#gemini-desktop-monitor') { try { sessionStorage.setItem('gq:desktop:monitor', '1'); } catch {} }
    const isSavedMonitor = () => { try { return sessionStorage.getItem('gq:desktop:monitor') === '1'; } catch { return false; } };
    const isStandaloneApp = () => {
        try {
            if (window.matchMedia?.('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)').matches) return true;
            if (window.toolbar && window.toolbar.visible === false) return true;
        } catch {}
        return false;
    };
    const get = (k, v) => { try { return GM_getValue(k, v); } catch { return v; } };
    const put = (k, v) => { try { GM_setValue(k, v); } catch {} };
    let ctx = account(document, location.href), data = null, disposed = false, signature = '', observerTimer = 0;
    let sending = false, connected = false;
    const sourceId = crypto.randomUUID(), loadedAt = Date.now();
    const key = () => 'gq:desktop:v1:reading:' + ctx.id;
    const monitorPage = () => isUsage(location.href) && (location.hash === '#gemini-desktop-monitor' || isSavedMonitor());
    function ensureMonitor() {
        if (!ctx.id) return;
        const alive = 'gq:desktop:v1:monitor-alive:' + ctx.id, now = Date.now();
        if (isUsage(location.href)) { put(alive, now); return; }
        // 真实浏览器里一律禁止自动新开 /usage 标签页弹窗；仅离线自动化测试（window.testOpens）允许验证
        if (!window.testOpens) return;
        const cooldown = 180000;
        const claim = 'gq:desktop:v1:monitor-spawn:' + ctx.id;
        if (!connected || now - get(alive, 0) < cooldown || now - get(claim, 0) < cooldown) return;
        put(claim, now);
        const url = ORIGIN + (ctx.slot === 'default' ? '' : '/u/' + ctx.slot) + '/usage#gemini-desktop-monitor';
        try { GM_openInTab(url, { active: false, insert: true, setParent: true }); } catch { /* 不抢焦点，不换其他浏览器 */ }
    }
    function valid(d, expected = ctx) { return d && expected.id && d.account?.id === expected.id && Date.now() - d.observedAt < 86400000; }
    function cache() {
        data = get(key(), null);
        if (!valid(data)) data = null;
        if (!data && ctx.id) {
            const old = get('gq:v2:cache:' + ctx.slot + ':' + ctx.id.replace(/^0+/, ''), null);
            if (old?.account?.identity === ctx.id.replace(/^0+/, '') && Date.now() - old.observedAt < 86400000) data = { ...old, account: ctx };
        }
    }
    function request(method, path, body) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({ method, url: BRIDGE.url + path, timeout: 4000,
            headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(path === '/meta' ? {} : { Authorization: 'Bearer ' + BRIDGE.token }) },
            data: body ? JSON.stringify(body) : undefined,
            onload: r => { if (r.status !== 200) return reject(new Error('local receiver unavailable')); try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('invalid receiver')); } },
            onerror: () => reject(new Error('desktop not running')), ontimeout: () => reject(new Error('desktop timeout')) }));
    }
    async function publish(bye = false, old = ctx) {
        if (!old.id || !bye && sending) return;
        if (bye) {
            try { await request('POST', '/ingest', { kind: 'bye', accountId: old.id, sourceId }); } catch {}
            return;
        }
        sending = true;
        try {
            const meta = await request('GET', '/meta');
            if (meta.service !== 'gemini-quota' || meta.id !== BRIDGE.serviceId) { connected = false; return; }
            connected = true;
            const hasData = valid(data);
            if (!hasData && window.testOpens) return;
            const fallbackCurrent = { used: 0, reset: { raw: '--', epoch: null } };
            const focused = !isUsage(location.href) && !document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus());
            await request('POST', '/ingest', {
                v: 2, kind: 'reading', accountId: ctx.id, sourceId, monitor: monitorPage(),
                current: hasData ? data.current : fallbackCurrent,
                weekly: hasData ? data.weekly : null,
                accountTag: ctx.tag || data?.account?.tag || '',
                plan: data?.plan || parsePlan(document.body) || '',
                focused,
                observedAt: hasData ? data.observedAt : Date.now(),
                sourceUpdated: hasData ? data.sourceUpdated : '刚刚更新' });
        } catch { connected = false; /* 桌宠没开时不刷新谷歌，不影响聊天 */ }
        finally { sending = false; ensureMonitor(); }
    }
    function accept(d) { if (!valid(d)) return false; data = d; put(key(), d); void publish(); return true; }
    function capture() {
        if (!ctx.id || !isUsage(location.href)) return false;
        const d = parse(document, location.href); if (!valid(d)) return false;
        const s = JSON.stringify([d.account, d.current, d.weekly, d.plan]);
        if (s !== signature) { signature = s; accept(d); }
        return true;
    }
    async function refresh() {
        if (disposed || !ctx.id || !navigator.onLine) return;
        capture(); ensureMonitor();
        if (!isUsage(location.href) || !connected || Date.now() - loadedAt < PERIOD) return;
        const k = 'gq:desktop:v1:monitor-reload:' + ctx.id, now = Date.now();
        if (now - get(k, 0) < PERIOD) return;
        put(k, now);
        // 只刷新用量页，不嵌入、不改安全策略，也不刷新用户聊天页。
        location.reload();
    }
    function sync() {
        const next = account(document, location.href);
        if (next.id !== ctx.id || next.slot !== ctx.slot) { const old = ctx; void publish(true, old); ctx = next; signature = ''; cache(); }
        else if (next.tag && !ctx.tag) ctx = next;
        capture();
    }
    const observer = new MutationObserver(() => { clearTimeout(observerTimer); observerTimer = setTimeout(sync, 450); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
    const heartbeat = setInterval(() => { sync(); const shared = get(key(), null); if (valid(shared) && (!data || shared.observedAt > data.observedAt)) data = shared; void publish(); }, 30000);
    const refreshTimer = setInterval(() => { sync(); void refresh(); }, 60000);
    const initial = setTimeout(() => { sync(); void publish(); void refresh(); }, 1500);
    const visible = () => { if (!document.hidden) { sync(); void publish(); void refresh(); } };
    const onFocus = () => { sync(); void publish(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', e => { if (e.persisted) return; disposed = true; void publish(true); observer.disconnect(); clearTimeout(observerTimer); clearTimeout(initial); clearInterval(heartbeat); clearInterval(refreshTimer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', onFocus); });
    cache(); sync();
})();
