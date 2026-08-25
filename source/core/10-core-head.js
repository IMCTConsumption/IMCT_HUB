
/* ════════════════════════════════════════════════════════════
   WATER METER LOGGER V2 — Frontend
   Aug 2026 patch: ports the full session-token auth + scoped-read
   architecture from the Electric (Substation) sister app.
   ════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   CONFIG — the ONLY block that differs between the four apps
   (Electric/Water × SR/GW). Generating another app = change this block.
   ═══════════════════════════════════════════════════════════ */
const APP_ID      = '{{APP_ID}}';   // must equal doGet's `app`; verified on load
const APP_NS      = '{{APP_NS}}';    // localStorage namespace — UNIQUE per app
const APP_VERSION = '{{APP_VERSION}}';
const SITE_NAME   = '{{SITE_NAME}}';
const SITE_CODE   = '{{SITE_CODE}}';
const UNIT        = '{{UNIT}}';
const API_URL     = '{{API_URL}}';
const QR_BASE_URL = '{{QR_BASE_URL}}';
const ABNORMAL_MULTIPLIER = 5;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // matches SESSION_TTL_SECONDS in Code.gs

/* ── localStorage namespacing ──
   All four apps share the ramesimct.github.io origin, so localStorage is
   shared. Keys are prefixed per-app (APP_NS) to prevent cross-app collision.
   `theme` is intentionally left un-prefixed so the light/dark choice is shared. */
function nsKey(k){ return APP_NS + ':' + k; }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(nsKey(k))); } catch(e){ return null; } }
function lsGetRaw(k){ return localStorage.getItem(nsKey(k)); }
function lsSetRaw(k, v){ localStorage.setItem(nsKey(k), v); }
function lsRemove(k){ localStorage.removeItem(nsKey(k)); }

/* ═══════════ REPORT GROUPS (consumption zoning) ═══════════
   Loaded live from the _REPORT_GROUPS sheet (doGet → reportGroups). An admin
   edits it directly in the Sheet — no code change to add a zone, move a meter,
   or change a cross-zone subtraction. Each group: {key,name,icon,color,meters,minus}.
   A meter's `zone` field (on _METERS) is display-grouping ONLY and is decoupled
   from this: a monitoring meter can appear under a zone yet be in no group here
   (so it is never counted in any consumption total). */
let reportGroups = Array.isArray(lsGet('reportGroups')) ? lsGet('reportGroups') : [];

function groupByKey(key){ return reportGroups.find(g => g.key === key) || null; }
function getGroupIds(key){ const g = groupByKey(key); return g ? (g.meters || []) : []; }
function zoneName(zoneKey){ const g = groupByKey(zoneKey); return (g && g.name) ? g.name : (zoneKey || 'อื่นๆ'); }
function zoneIcon(zoneKey){ const g = groupByKey(zoneKey); return (g && g.icon) ? g.icon : '📦'; }

/* ───────── STATE ───────── */
let subs                   = Array.isArray(lsGet('subs'))     ? lsGet('subs')     : [];
let records                = [];  // never hydrated from localStorage — admin-session-only
let workCalendar           = Array.isArray(lsGet('calendar')) ? lsGet('calendar') : [];
let filteredRecords        = [];
let currentPage            = 1;
let pageSize               = 15;
let activeFilter           = { sub:'', user:'', from:'', to:'' };
let appMode                = 'basic';
let activeSub              = null;
let editSubIndex           = null;
let isConnected            = false;
let currentEditingRecordId = null;
let currentUser            = '';
let sessionToken           = null;
let compareMode            = 'day';

/* ───────── UTILITIES ───────── */
function esc(str){
  if(str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function persist(){
  lsSetRaw('subs',         JSON.stringify(subs));
  lsSetRaw('calendar',     JSON.stringify(workCalendar));
  lsSetRaw('reportGroups', JSON.stringify(reportGroups));
}
function fmtDate(d){
  if(!d) return '—';
  let obj;
  if(String(d).includes('T')) obj = new Date(d);
  else { const [y,m,dy] = String(d).split('-'); obj = new Date(y, m-1, dy); }
  if(isNaN(obj.getTime())) return String(d);
  return `${String(obj.getDate()).padStart(2,'0')}/${String(obj.getMonth()+1).padStart(2,'0')}/${obj.getFullYear()}`;
}
function fmtTime(t){
  if(!t) return '—';
  if(String(t).includes('T')){
    const obj = new Date(t);
    if(!isNaN(obj.getTime())) return `${String(obj.getHours()).padStart(2,'0')}:${String(obj.getMinutes()).padStart(2,'0')}`;
  }
  return String(t).slice(0,5) || '—';
}
/* Renders the "used" column. null means the figure does not exist for this
   kind of meter — a demand register's readings are kW peaks and a snapshot is
   an instantaneous value, so there is no consumption to show. `r.used || 0`
   collapsed that null into a confident-looking 0, which reads as "used nothing
   today" rather than "this column does not apply here". */
function fmtUsedCell(used, meterId){
  if(used === null || used === undefined) return '<span style="color:var(--rd-ink-3)">—</span>';
  return fmtNum(used, meterId);
}

function fmtNum(val, meterId){
  const sub = subs.find(s => s.id === meterId);
  const dec = sub && sub.decimal !== undefined ? sub.decimal : 0;
  return parseFloat(val || 0).toFixed(dec);
}
function fmtChartDate(dateStr){
  if(!dateStr) return '—';
  let obj;
  if(String(dateStr).includes('T')) obj = new Date(dateStr);
  else { const [y,m,dy] = String(dateStr).split('-'); obj = new Date(y, m-1, dy); }
  if(isNaN(obj.getTime())) return String(dateStr);
  return `${String(obj.getDate()).padStart(2,'0')}/${String(obj.getMonth()+1).padStart(2,'0')}`;
}
/* Local-date helper. toISOString() formats in UTC, so using it to derive
   "today" or a date-range boundary silently shifts the answer back a day for
   the seven hours after Thai midnight. Every date this app exchanges with the
   sheet is an Asia/Bangkok calendar date, so all of them are built from the
   local clock instead. */
function ymdLocal(d){
  const dt = d || new Date();
  const pad = v => String(v).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth()+1) + '-' + pad(dt.getDate());
}

function setNow(){
  // toISOString() reports UTC. Paired with toTimeString()'s local clock it
  // produced a date and a time from two different days for any reading taken
  // between midnight and 07:00 Thai time — the time said 01:00 while the date
  // had already rolled back to the previous day. The backend decides "today"
  // in Asia/Bangkok, so the client has to agree with it.
  const n  = new Date();
  const ed = document.getElementById('in-date');
  const et = document.getElementById('in-time');
  const pad = v => String(v).padStart(2, '0');
  if(ed) ed.value = n.getFullYear() + '-' + pad(n.getMonth()+1) + '-' + pad(n.getDate());
  if(et) et.value = pad(n.getHours()) + ':' + pad(n.getMinutes());
}
function getLastKwh(meterId){
  const sorted = records.filter(r => r.meterId === meterId)
    .sort((a,b) => (`${b.date} ${b.time||'00:00'}`).localeCompare(`${a.date} ${a.time||'00:00'}`));
  return sorted.length ? parseFloat(sorted[0].kwh) || 0 : null;
}
function getSubRecs(meterId){
  return records.filter(r => r.meterId === meterId)
    .sort((a,b) => (`${a.date} ${a.time||'00:00'}`).localeCompare(`${b.date} ${b.time||'00:00'}`));
}

/* ════════════ SESSION PERSISTENCE ════════════ */
let sessionExpiresAt = null;
let pendingQrSub = null;
let sessionExpiryWarned = false;

function persistSession(token, role, name){
  sessionExpiresAt = Date.now() + SESSION_TTL_MS;
  localStorage.setItem(nsKey('authSession'), JSON.stringify({ token, role, name, expiresAt: sessionExpiresAt }));
  sessionExpiryWarned = false;
  hideSessionExpiredBanner();
}
function clearSessionStorage(){
  localStorage.removeItem(nsKey('authSession'));
  sessionExpiresAt = null;
}
function restoreSession(){
  let saved;
  try{ saved = JSON.parse(localStorage.getItem(nsKey('authSession'))); }catch(e){ saved = null; }
  if(!saved || !saved.token || !saved.expiresAt) return false;
  if(Date.now() >= saved.expiresAt){ clearSessionStorage(); return false; }
  sessionToken     = saved.token;
  currentUser      = saved.name || '';
  sessionExpiresAt = saved.expiresAt;
  applyAppMode(saved.role === 'admin' ? 'admin' : 'basic');
  closeLoginGate();
  return true;
}
function showSessionExpiredBanner(){
  const el = document.getElementById('session-expired-banner');
  if(el) el.style.display = 'block';
  setWriteLock(true);      // an expired session must not be able to write
}
function hideSessionExpiredBanner(){
  const el = document.getElementById('session-expired-banner');
  if(el) el.style.display = 'none';
  setWriteLock(false);
}

/* Disable every control that writes data while the session is invalid.
   The banner alone was only a label — the save/edit/delete buttons stayed
   live, so an expired session could still modify the sheet for as long as
   the server-side token happened to outlast the client's own timer. */
function setWriteLock(locked){
  const ids = ['save-btn','unable-btn'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(el){
      el.disabled = locked;
      el.title = locked ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : '';
    }
  });
  document.querySelectorAll('[data-write-action]').forEach(el => { el.disabled = locked; });
  window.__writeLocked = !!locked;
}
function checkSessionExpiry(){
  if(!sessionExpiresAt || sessionExpiryWarned) return;
  if(Date.now() >= sessionExpiresAt){
    sessionExpiryWarned = true;
    showSessionExpiredBanner();
  }
}
setInterval(checkSessionExpiry, 60000);

/* ════════════ LOGIN ════════════ */
function logout(){
  if(!confirm('ออกจากระบบและกลับไปหน้าเลือกโหมด?')) return;
  if(sessionToken){
    const tokenToRevoke = sessionToken;
    apiPost({ action:'logout', token: tokenToRevoke }).catch(() => {});
  }
  lsRemove('loginMode');
  clearSessionStorage();
  currentUser = '';
  sessionToken = null;
  records = [];
  applyAppMode('basic');           // reset role, and with it the sidebar contents
  _adminRecordsInFlight = null;    // drop any in-flight admin pull from the old session
  bulkRecent = null;               // stale once the session ends
  historyLoadFailed = false;
  activeSub = null;
  activeSubRecent = [];
  lsRemove('records');
  hideSessionExpiredBanner();
  // #login-choose is an empty compatibility stub after the login redesign —
  // showing it left the gate visually blank. Land on the recorder form instead.
  const gate = document.getElementById('login-gate');
  gate.style.display = 'flex';
  gate.style.opacity = '1';
  rdShowRecorder();
  const errA = document.getElementById('login-err');
  if(errA) errA.style.display = 'none';
  const errR = document.getElementById('recorder-login-err');
  if(errR) errR.style.display = 'none';
}
function showRecorderLogin(fromExpiredBanner){
  document.getElementById('login-choose').style.display   = 'none';
  document.getElementById('login-admin').style.display    = 'none';
  document.getElementById('login-recorder').style.display = 'block';
  if(fromExpiredBanner){
    const gate = document.getElementById('login-gate');
    gate.style.display = 'flex'; gate.style.opacity = '1';
  }
  setTimeout(() => document.getElementById('recorder-pass')?.focus(), 100);
}
async function handleRecorderLogin(){
  const passVal  = document.getElementById('recorder-pass').value.trim();
  const errDiv   = document.getElementById('recorder-login-err');
  const loginBtn = document.getElementById('recorder-login-btn');
  if(!passVal){ errDiv.style.display = 'block'; errDiv.innerText = '⚠️ กรุณากรอกรหัสผ่าน'; return; }
  errDiv.style.display = 'none';
  const originalHTML = loginBtn.innerHTML;
  loginBtn.disabled = true; loginBtn.innerHTML = '⏳ กำลังตรวจสอบ...';
  try{
    const res = await apiPost({ action:'login', username:'recorder', password:passVal });
    if(res && res.success){
      currentUser = res.name || 'ทีมจดมิเตอร์';
      sessionToken = res.token || null;
      persistSession(res.token, res.role || 'recorder', currentUser);
      applyAppMode('basic');
      lsSetRaw('loginMode','basic');
      document.getElementById('recorder-pass').value = '';
      closeLoginGate();
      await loadMeterStatus();
      if(pendingQrSub){
        goTab('entry');
        const found = subs.find(s => s.id === pendingQrSub);
        if(found){ await selectSub(found.id); toast('📍 เปิด ' + found.id + ' จาก QR','ok'); }
        pendingQrSub = null;
      }
      renderAll();
    } else {
      errDiv.style.display = 'block'; errDiv.innerText = '❌ ' + (res?.error || 'รหัสผ่านไม่ถูกต้อง');
      const el = document.getElementById('recorder-pass');
      el.style.animation = 'shake 0.4s ease'; setTimeout(() => { el.style.animation = ''; }, 400);
    }
  }catch(e){
    errDiv.style.display = 'block'; errDiv.innerText = '❌ เชื่อมต่อ Server ไม่ได้';
  }finally{
    loginBtn.disabled = false; loginBtn.innerHTML = originalHTML;
  }
}
function showAdminLogin(){
  document.getElementById('login-choose').style.display   = 'none';
  document.getElementById('login-recorder').style.display = 'none';
  document.getElementById('login-admin').style.display    = 'block';
  setTimeout(() => document.getElementById('login-user')?.focus(), 100);
}
function backToChoose(){
  document.getElementById('login-admin').style.display    = 'none';
  document.getElementById('login-recorder').style.display = 'none';
  document.getElementById('login-choose').style.display   = 'block';
  document.getElementById('login-err').style.display      = 'none';
  document.getElementById('recorder-login-err').style.display = 'none';
}
async function handleLogin(){
  const userVal  = document.getElementById('login-user').value.trim();
  const passVal  = document.getElementById('login-pass').value.trim();
  const errDiv   = document.getElementById('login-err');
  const loginBtn = document.getElementById('login-btn');
  if(!userVal || !passVal){
    errDiv.style.display = 'block'; errDiv.innerText = '⚠️ กรุณากรอกชื่อผู้ใช้และรหัสผ่าน'; return;
  }
  errDiv.style.display = 'none';
  const originalHTML = loginBtn.innerHTML;
  loginBtn.disabled  = true; loginBtn.innerHTML = '⏳ กำลังตรวจสอบ...';
  try{
    const res = await apiPost({ action:'login', username:userVal, password:passVal });
    if(res && res.success && res.role === 'admin'){
      currentUser = res.name || userVal;
      sessionToken = res.token || null;
      persistSession(res.token, 'admin', currentUser);
      applyAppMode('admin');
      lsRemove('loginMode');
      closeLoginGate();
      loginBtn.innerHTML = '⏳ กำลังโหลดข้อมูล...';
      await loadAdminRecords();
      renderAll();
    } else if(res && res.success){
      errDiv.style.display = 'block'; errDiv.innerText = '⚠️ บัญชีนี้ไม่มีสิทธิ์แอดมิน'; shakeInputs();
    } else {
      errDiv.style.display = 'block'; errDiv.innerText = '❌ ' + (res?.error || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); shakeInputs();
    }
  }catch(e){
    errDiv.style.display = 'block'; errDiv.innerText = '❌ เชื่อมต่อ Server ไม่ได้';
  }finally{
    loginBtn.disabled = false; loginBtn.innerHTML = originalHTML;
  }
}
function shakeInputs(){
  ['login-user','login-pass'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.style.animation = 'shake 0.4s ease';
    setTimeout(() => { el.style.animation = ''; }, 400);
  });
}
function closeLoginGate(){
  const gate = document.getElementById('login-gate');
  gate.style.transition = 'opacity 0.3s';
  gate.style.opacity = '0';
  setTimeout(() => { gate.style.display = 'none'; gate.style.opacity = '1'; }, 300);
}
function applyAppMode(mode){
  appMode = mode;
  const tabsBar = document.getElementById('tabs-bar');
  if(tabsBar) tabsBar.className = mode === 'admin' ? 'tabs admin-mode' : 'tabs basic-mode';
  // Push the role change into the sidebar right away. It used to refresh only
  // inside rdOpenDrawer(), so after signing out of admin and back in as a
  // recorder the drawer kept rendering the admin-only entries until the tab
  // was reloaded.
  try { rdApplyRoleVisibility(); rdSyncDrawerUser(); rdSyncDrawerActive(); } catch(e){ /* drawer not in DOM yet during early init */ }
  const hdrSmall = document.getElementById('hdr-small');
  if(hdrSmall){
    if(mode === 'admin'){
      hdrSmall.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:-1px;margin-right:3px"><path d="m2 7 4.5 4.5L12 5l5.5 6.5L22 7v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/></svg>แอดมิน: ${esc(currentUser)}`;
    } else {
      hdrSmall.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;display:inline-block;vertical-align:-1px;margin-right:3px"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>โหมดบันทึก${currentUser ? ' — '+esc(currentUser) : ''}`;
    }
  }
}

/* ════════════ THEME ════════════ */
function initTheme(){
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(saved || (prefersDark ? 'dark' : 'light'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if(!localStorage.getItem('theme')) setTheme(e.matches ? 'dark' : 'light');
  });
}
function setTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-btn');
  if(btn){
    btn.innerHTML = t === 'dark'
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
  }
}
function toggleTheme(){
  const cur = document.documentElement.getAttribute('data-theme');
  const nxt = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', nxt); setTheme(nxt);
  setTimeout(function(){
    if(typeof subChartInst!=='undefined' && subChartInst) renderSubChart();
    if(typeof g9ChartInst!=='undefined' && g9ChartInst) renderG9Chart();
    if(typeof cmpChartInst!=='undefined' && cmpChartInst) renderCmpChart();
  }, 100);
}

/* ════════════ API ════════════ */
let DEBUG_PERF = false;
try { if(location.search.indexOf('perf=1')>=0) DEBUG_PERF = true; } catch(e){}
const _perfSeen = new Set();
function perfLabel(name){
  if(!_perfSeen.has(name)){ _perfSeen.add(name); return name+' [COLD]'; }
  return name+' [WARM]';
}
function perfStart(name){ if(!DEBUG_PERF) return; performance.mark(name+'-start'); }
function perfEnd(name){
  if(!DEBUG_PERF) return;
  performance.mark(name+'-end');
  try{
    performance.measure(name, name+'-start', name+'-end');
    const entry = performance.getEntriesByName(name).pop();
    if(entry) console.log(`⏱ ${name}: ${entry.duration.toFixed(2)} ms`);
  }catch(e){}
  performance.clearMarks(name+'-start');
  performance.clearMarks(name+'-end');
  performance.clearMeasures(name);
}

/* Per-action timeout. getRawRecords walks the whole sheet server-side and
   legitimately takes longer than a status ping, so a single flat ceiling
   either cut off the heavy call or made the light ones hang. */
const SLOW_ACTIONS = { getRawRecords: 45000, getRecentRecordsAll: 45000, getMonthlySummary: 30000, getAvailableMonths: 20000 };

/* Apps Script runs one execution at a time per script. Issuing several heavy
   calls at once therefore does not make them finish sooner — it makes the ones
   behind the first sit idle until they blow their own timeout, and their
   single-use /exec redirect target 404s by the time the browser follows it.
   Everything goes through one chain so each call gets its full budget for its
   own work rather than spending it queued behind someone else's. */
let _apiChain = Promise.resolve();
function apiPost(body, retries = 2){
  const run = () => _apiPostNow(body, retries);
  const queued = _apiChain.then(run, run);
  _apiChain = queued.catch(() => {});   // a failure must not break the chain
  return queued;
}

async function _apiPostNow(body, retries = 2){
  const timeoutMs = (body && SLOW_ACTIONS[body.action]) || 12000;
  for(let attempt = 0; attempt <= retries; attempt++){
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try{
      const res  = await fetch(API_URL, { method:'POST', body:JSON.stringify(body), signal:ctrl.signal });
      clearTimeout(tid);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if(data.status === 'error') throw new Error(data.message || 'Server error');
      return data;
    }catch(e){
      clearTimeout(tid);
      if(attempt === retries) throw e;
      // Log retries: previously silent, which made a 404 in the console
      // impossible to tell apart from a call that recovered on attempt 2.
      console.warn('⚠️ apiPost[' + (body && body.action) + '] attempt ' + (attempt+1) + ' failed (' + e.message + ') — retrying...');
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

/* opts.background — for prefetches the person did not ask for.
   A background call that comes back with a session error must NOT tear down
   the session: the prefetch can lose a race with login, or simply arrive
   while the token is being refreshed, and signing the user out because an
   optional optimisation failed is far worse than skipping the optimisation.
   Only work the person actually initiated is allowed to trigger a logout. */
async function apiPostAuthed(body, opts){
  const background = !!(opts && opts.background);
  const res = await apiPost(Object.assign({}, body, { token: sessionToken }));
  if(!res || res.success === false){
    const msg = (res && res.error) || 'การดำเนินการล้มเหลว';
    const isSessionErr = res && /session|เข้าสู่ระบบ/i.test(res.error || '');
    if(background){
      console.warn('⚠️ background ' + (body && body.action) + ' failed: ' + msg);
      throw new Error(msg);
    }
    toast('❌ ' + msg, 'err');
    if(isSessionErr){
      sessionToken = null;
      setTimeout(() => { logout(); }, 1200);
    }
    throw new Error(msg);
  }
  return res;
}

/* ════════════ SCOPED DATA LOADERS ════════════ */
let meterStatus = {};
let meterStatusToday = {};
/* The logging day the red/green marks refer to. The round runs late at night,
   so the backend rolls this over at 16:30 rather than midnight — without
   showing it, a green board on the morning of the 19th looks wrong to anyone
   who reads it as "recorded today". */
let loggingDayLabel = null;  // {meterId: true/false} — has a reading dated TODAY (Asia/Bangkok)
let activeSubRecent = [];

/* Months that actually contain data, fetched from the server.
   Independent of the in-memory `records` window, so the pickers can offer
   every month that exists without the client holding the whole dataset. */
let availableMonths = null;   // array of 'YYYY-MM', newest first

async function loadAvailableMonths(){
  try{
    const res = await apiPost({ action:'getAvailableMonths' });
    if(res && res.success && Array.isArray(res.months)) availableMonths = res.months;
  }catch(e){ console.warn('⚠️ โหลดรายการเดือนไม่ได้:', e.message); }
  return availableMonths;
}

/* Recent readings for every meter, fetched once.
   Opening a meter used to fire its own getRecentRecords call, so a recorder
   walking 66 meters made 66 round-trips — each one re-reading the whole sheet
   server-side. This pulls them all in a single request and serves meter opens
   from memory. Falls back to the per-meter call if the bulk set is missing or
   doesn't contain the meter (e.g. a meter added since the last fetch). */
let bulkRecent = null;          // { meterId: [records newest-first] }

let _bulkRecentInFlight = null;

async function loadBulkRecent(){
  if(_bulkRecentInFlight) return _bulkRecentInFlight;
  _bulkRecentInFlight = _loadBulkRecentInner();
  try { return await _bulkRecentInFlight; }
  finally { _bulkRecentInFlight = null; }
}

async function _loadBulkRecentInner(){
  if(!sessionToken) return null;   // nothing to authenticate with yet
  try{
    const res = await apiPostAuthed({ action:'getRecentRecordsAll' }, { background:true });
    if(res && res.success && res.byMeter) bulkRecent = res.byMeter;
  }catch(e){ console.warn('⚠️ โหลดประวัติรวมไม่ได้ — จะดึงทีละมิเตอร์แทน:', e.message); }
  return bulkRecent;
}

async function loadMeterStatus(){
  // ONE request returns both maps (see getMeterStatus in Code.gs). Kept as a
  // single round-trip on purpose: the /exec endpoint is the slowest hop and
  // has shown intermittent 404s under parallel load, so we don't fan out here.
  try{
    const res = await apiPost({ action:'getMeterStatus', meterIds: subs.map(s => s.id) });
    if(res && res.success){
      if(res.status) meterStatus = res.status;
      if(res.today)  meterStatusToday = res.today;
      if(res.date)   loggingDayLabel = res.date;
    }
  }catch(e){ console.warn('⚠️ โหลดสถานะมิเตอร์ไม่ได้:', e.message); }
  // Month list is only needed by the admin report pickers — fetch it lazily
  // and never block the entry screen on it.
  if(appMode === 'admin' && !availableMonths) loadAvailableMonths();
  // Deliberately NOT awaited: this is a prefetch that saves a request when a
  // meter is later opened, not something the entry screen needs in order to
  // paint. Awaiting it here put a whole-sheet read on the critical path next
  // to the other heavy calls, which is what pushed them into timeouts.
  if(sessionToken) loadBulkRecent();
}
/* ── Admin record window ──
   The full history is thousands of rows and is the single slowest thing in
   the app: loading it blocks the entry screen from painting. Day-to-day work
   (checking today's readings, fixing a wrong entry) only ever touches recent
   data, so we load a rolling window by default and let the admin pull the
   full set on demand from the Data tab.
   NOTE: the Summary/report numbers do NOT come from this array — they're
   computed server-side by getMonthlySummary — so narrowing this window never
   changes any reported consumption figure. */
const ADMIN_RECORD_WINDOW_DAYS = 90;
let recordsWindowFrom = null;   // 'YYYY-MM-DD', or null when the full set is loaded

function _windowStartDate(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  return ymdLocal(d);
}

/* Guards against the same heavy pull running twice concurrently. handleLogin()
   and loadFromServer() both request the admin record set after a login, and on
   Apps Script two simultaneous full-sheet reads block each other long enough
   for both to hit the client timeout. Callers now share one in-flight promise. */
let _adminRecordsInFlight = null;

async function loadAdminRecords(opts){
  if(_adminRecordsInFlight) return _adminRecordsInFlight;
  _adminRecordsInFlight = _loadAdminRecordsInner(opts);
  try { return await _adminRecordsInFlight; }
  finally { _adminRecordsInFlight = null; }
}

async function _loadAdminRecordsInner(opts){
  const loadAll = !!(opts && opts.all);
  const dateFrom = loadAll ? null : _windowStartDate(ADMIN_RECORD_WINDOW_DAYS);
  try{
    const payload = { action:'getRawRecords' };
    if(dateFrom) payload.dateFrom = dateFrom;
    const res = await apiPostAuthed(payload);
    records = computeUsed(res.records || []);
    recordsWindowFrom = dateFrom;
    persist();
    updateRecordWindowNotice();
  }catch(e){ /* apiPostAuthed already surfaced the error toast */ }
}

async function loadAllAdminRecords(){
  const btn = document.getElementById('load-all-btn');
  if(btn){ btn.disabled = true; btn.innerHTML = '⏳ กำลังโหลด...'; }
  setSyncStatus('busy','กำลังโหลดข้อมูลทั้งหมด...');
  await loadAdminRecords({ all:true });
  renderAll();
  setSyncStatus('ok','โหลดข้อมูลทั้งหมดแล้ว — ' + records.length + ' รายการ');
  if(btn){ btn.disabled = false; btn.innerHTML = '📚 โหลดข้อมูลทั้งหมด'; }
}

function updateRecordWindowNotice(){
  const el = document.getElementById('record-window-notice');
  if(!el) return;
  if(recordsWindowFrom){
    el.style.display = 'block';
    el.innerHTML = 'กำลังแสดงข้อมูล <strong>' + ADMIN_RECORD_WINDOW_DAYS + ' วันล่าสุด</strong> (ตั้งแต่ ' + fmtDate(recordsWindowFrom) + ') · ' + records.length + ' รายการ — ตัวเลขในหน้าสรุปไม่ได้รับผลกระทบ';
  } else {
    el.style.display = 'block';
    el.innerHTML = 'กำลังแสดง <strong>ข้อมูลทั้งหมด</strong> · ' + records.length + ' รายการ';
  }
}
async function loadRecentForSub(meterId, limit){
  const res = await apiPost({ action:'getRecentRecords', meterId, limit: limit || 5, token: sessionToken });
  if(!res || !res.success) throw new Error((res && res.error) || 'โหลดประวัติมิเตอร์ไม่ได้');
  return res.records || [];
}

/* ════════════ SUMMARY API CACHE ════════════ */
let summaryCache = {};
function _snapDayRangeToMonths(dateFrom, dateTo){
  const from = dateFrom.slice(0,7) + '-01';
  const [ty, tm] = dateTo.slice(0,7).split('-').map(Number);
  const lastDay = new Date(ty, tm, 0).getDate();
  const to = dateTo.slice(0,7) + '-' + String(lastDay).padStart(2,'0');
  return [from, to];
}
async function getSummaryCached(dateFrom, dateTo, granularity){
  let qFrom = dateFrom, qTo = dateTo;
  if(granularity === 'day' && dateFrom && dateTo){
    [qFrom, qTo] = _snapDayRangeToMonths(dateFrom, dateTo);
  }
  const key = `${qFrom||''}|${qTo||''}|${granularity||'day'}`;
  if(summaryCache[key]){
    if(DEBUG_PERF) console.log(`⏱ getSummaryCached [HIT] ${key}: 0 ms (cached)`);
    return summaryCache[key];
  }
  const _t0 = (DEBUG_PERF && performance.now()) || 0;
  const res = await apiPostAuthed({ action:'getMonthlySummary', dateFrom:qFrom, dateTo:qTo, granularity });
  if(DEBUG_PERF) console.log(`⏱ getSummaryCached [MISS→network] ${key}: ${(performance.now()-_t0).toFixed(0)} ms`);
  if(res && res.success) summaryCache[key] = res;
  return res;
}
function invalidateSummaryCache(reason){
  const keys = Object.keys(summaryCache).length;
  summaryCache = {};
  console.log(`🗑 invalidateSummaryCache — ล้าง ${keys} keys, reason: ${reason||'ไม่ระบุ'}`);
}

function safeDestroyChart(inst){
  if(!inst) return;
  try{ inst.destroy(); }
  catch(e){ console.warn('chart destroy guarded:', e && e.message); }
}

const _scriptPromises = {};
function loadScript(url){
  if(_scriptPromises[url]) return _scriptPromises[url];
  _scriptPromises[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => { delete _scriptPromises[url]; reject(new Error('โหลด script ไม่ได้: '+url)); };
    document.head.appendChild(s);
  });
  return _scriptPromises[url];
}
const CDN = {
  qrcode:     'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  xlsx:       'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  apexcharts: 'https://cdn.jsdelivr.net/npm/apexcharts@3.50.0/dist/apexcharts.min.js',
  exceljs:    'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'
};
function ensureQRCode(){    return (typeof QRCode!=='undefined')    ? Promise.resolve() : loadScript(CDN.qrcode); }
function ensureXLSX(){      return (typeof XLSX!=='undefined')      ? Promise.resolve() : loadScript(CDN.xlsx); }
function ensureApex(){      return (typeof ApexCharts!=='undefined') ? Promise.resolve() : loadScript(CDN.apexcharts); }

function setSyncStatus(status, msg){
  const dot = document.getElementById('sync-dot');
  const ban = document.getElementById('sync-banner');
  const ico = document.getElementById('sync-icon');
  const bm  = document.getElementById('sync-msg');
  dot.className = 'sync-dot ' + (status==='ok' ? 'ok' : status==='busy' ? 'busy' : 'err');
  if(status === 'busy'){
    ban.className = 'sync-banner show loading'; ico.textContent = '⏳'; bm.textContent = msg || 'กำลัง sync...';
  } else if(status === 'error'){
    ban.className = 'sync-banner show error'; ico.textContent = '❌'; bm.textContent = msg || 'เชื่อมต่อไม่ได้';
    setTimeout(() => { ban.className = 'sync-banner'; }, 5000);
  } else {
    ban.className = 'sync-banner show success'; ico.textContent = '✅'; bm.textContent = msg || 'Sync สำเร็จ';
    setTimeout(() => { ban.className = 'sync-banner'; }, 2500);
  }
}
/* Fetch the doGet payload with retries.
   The Apps Script /exec endpoint answers a GET by 302-ing to a one-shot
   script.googleusercontent.com/macros/echo URL, and that redirect target
   intermittently returns 404 — a Google-side failure, not a bad request.
   apiPost() already retried; this path did not, even though it's the FIRST
   request the app makes on load. A single blip therefore dropped the app
   straight to cached data (blank on a fresh browser). Same backoff as apiPost. */
async function _fetchDoGet(retries = 2){
  // 8s, not 20s: a healthy Apps Script doGet answers in ~1-3s. Waiting 20s
  // three times over meant a failing load could hang the app for a minute
  // before falling back to cache — far worse than failing fast and retrying.
  let lastErr;
  for(let attempt = 0; attempt <= retries; attempt++){
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    try{
      const res = await fetch(API_URL, { signal: ctrl.signal });
      clearTimeout(tid);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }catch(e){
      clearTimeout(tid);
      lastErr = e;
      if(attempt < retries){
        console.warn('⚠️ loadFromServer attempt ' + (attempt+1) + ' failed (' + e.message + ') — retrying...');
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function loadFromServer(){
  const _plApi = perfLabel('loadFromServer:api'); perfStart(_plApi);
  return _fetchDoGet()
    .then(data => {
      perfEnd(_plApi);
      return data;
    })
    .then(async data => {
      if(!data || data.status === 'error') throw new Error(data?.message || 'Server error');
      // Wrong backend means the API_URL points at another app's deployment.
      // Loading its meters would leave this app showing another site's data
      // and persist it under this app's localStorage namespace, so refuse the
      // payload entirely rather than warn and carry on. The `data.app &&`
      // guard lets a backend that predates this field through untouched.
      if(data.app && data.app !== APP_ID){
        throw new Error('Backend ผิดแอป: ได้ ' + data.app + ' คาดว่า ' + APP_ID);
      }
      if(data.meters       && Array.isArray(data.meters))       subs         = data.meters;
      if(data.reportGroups && Array.isArray(data.reportGroups)) reportGroups = data.reportGroups;
      if(data.calendar     && Array.isArray(data.calendar))     workCalendar = data.calendar;
      persist(); isConnected = true; invalidateSummaryCache('loadFromServer');
      await loadMeterStatus();
      if(appMode === 'admin' && sessionToken) await loadAdminRecords();
      renderAll();
      if(activeSub){
        const sb = document.getElementById('save-btn');
        if(sb && !sb.disabled){ sb.innerHTML = '✅ บันทึกข้อมูล'; }
      }
      console.log(`✅ Sync — ${subs.length} subs, ${workCalendar.length} cal${appMode==='admin' ? ', '+records.length+' records' : ''}`);
    })
    .catch(err => { console.warn('⚠️ โหลด Server ไม่ได้ ใช้ Cache:', err.message); isConnected = false; });
}
function refreshData(){
  const btn = document.getElementById('refresh-btn');
  if(btn){ btn.disabled = true; btn.innerHTML = '⏳ กำลังโหลด...'; }
  setSyncStatus('busy','กำลังโหลดข้อมูล...');
  const _plApiR = perfLabel('refreshData:api'); perfStart(_plApiR);
  _fetchDoGet()                       // same retry/timeout wrapper as loadFromServer
    .then(data => {
      perfEnd(_plApiR);
      return data;
    })
    .then(async data => {
      if(!data || data.status === 'error') throw new Error(data?.message || 'Server error');
      // Wrong backend means the API_URL points at another app's deployment.
      // Loading its meters would leave this app showing another site's data
      // and persist it under this app's localStorage namespace, so refuse the
      // payload entirely rather than warn and carry on. The `data.app &&`
      // guard lets a backend that predates this field through untouched.
      if(data.app && data.app !== APP_ID){
        throw new Error('Backend ผิดแอป: ได้ ' + data.app + ' คาดว่า ' + APP_ID);
      }
      if(data.meters       && Array.isArray(data.meters))       subs         = data.meters;
      if(data.reportGroups && Array.isArray(data.reportGroups)) reportGroups = data.reportGroups;
      if(data.calendar     && Array.isArray(data.calendar))     workCalendar = data.calendar;
      persist(); isConnected = true; invalidateSummaryCache('refreshData');
      await loadMeterStatus();
      if(appMode === 'admin' && sessionToken) await loadAdminRecords();
      renderAll();
      setSyncStatus('ok',`โหลดสำเร็จ — ${subs.length} Meter`);
    })
    .catch(err => { setSyncStatus('error','โหลดไม่ได้: ' + err.message); })
    .finally(() => { if(btn){ btn.disabled = false; btn.innerHTML = '🔄 Refresh'; } });
}
async function testConn(){
  setSyncStatus('busy','กำลังทดสอบ...');
  const box = document.getElementById('api-status');
  box.style.display = 'block';
  try{
    const res = await fetch(API_URL);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(data.status === 'error') throw new Error(data.message);
    setSyncStatus('ok','เชื่อมต่อสำเร็จ');
    const recNote = appMode === 'admin' ? `${records.length} records, ` : '';
    box.innerHTML = `<div class="info-box">✅ เชื่อมต่อสำเร็จ — ${recNote}${subs.length} subs</div>`;
  }catch(e){
    setSyncStatus('error','ล้มเหลว');
    box.innerHTML = `<div class="warn-box">❌ ${e.message}</div>`;
  }
}

function computeUsed(rawRecords){
  const _pl = perfLabel('computeUsed(n='+rawRecords.length+')'); perfStart(_pl);
  rawRecords.forEach(r => { if(r.date && String(r.date).includes('T')) r.date = String(r.date).slice(0, 10); });
  const groups = {};
  rawRecords.forEach(r => { if(!groups[r.meterId]) groups[r.meterId]=[]; groups[r.meterId].push(r); });
  // Index the meter list once. This used to call subs.find() inside the loop,
  // which is a linear scan per meter — fine at a handful of meters, but with
  // ~66 meters over thousands of records it is a lot of pointless comparing.
  const subMap = {};
  subs.forEach(s => { subMap[s.id] = s; });
  Object.keys(groups).forEach(meterId => {
    const sub        = subMap[meterId];
    const multiplier = sub?.multiplier !== undefined ? parseFloat(sub.multiplier) : 1;
    const vt         = meterValueType(sub);
    const chain = groups[meterId].sort((a,b) => (`${a.date} ${a.time||'00:00'}`).localeCompare(`${b.date} ${b.time||'00:00'}`));
    chain.forEach((rec, i) => {
      // `used` means "energy consumed since the previous reading". That only
      // exists for a totalising register. A demand meter's reading is a kW
      // peak and a snapshot is an instantaneous value — subtracting two of
      // them produces a number with no physical meaning, which would then
      // flow into the Data table, the charts and the group totals as if it
      // were kWh. null keeps them out and lets the UI render "—".
      if(vt === 'demand' || vt === 'snapshot'){ rec.used = null; return; }
      if(i === chain.length - 1){ rec.used = 0; }
      else {
        const diff = parseFloat(chain[i+1].kwh) - parseFloat(rec.kwh);
        // A counter's difference IS meaningful (events elapsed), so it is
        // computed — but it is a count, not energy, and callers that total
        // kWh must exclude it. See sumGroupOnDay().
        rec.used = Math.max(0, diff) * (vt === 'counter' ? 1 : multiplier);
      }
    });
  });
  const _out = Object.values(groups).flat();
  perfEnd(_pl);
  return _out;
}

async function init(){
  if(!Array.isArray(subs)) subs = [];
  subs = subs.map(s => ({ ...s, decimal: s.decimal !== undefined ? s.decimal : 0 }));
  initTheme(); setNow();
  { const t = document.getElementById('hdr-title'); if(t) t.textContent = SITE_NAME + ' — ' + SITE_CODE; }
  const hasSession = restoreSession();
  renderAll();
  document.getElementById('qr-url-preview').textContent = QR_BASE_URL + '?meter={{QR_SAMPLE}}';
  const params = new URLSearchParams(location.search);
  const p = params.get('meter') || params.get('sub');  // accept both (old printed QR = ?sub=)
  if(p){
    pendingQrSub = p.toUpperCase();
    if(hasSession){
      goTab('entry');
      const cached = subs.find(s => s.id === pendingQrSub);
      if(cached){
        // cache-first: open the scanned meter immediately, refresh in background
        await selectSub(cached.id);
        toast('📍 เปิด ' + cached.id + ' จาก QR','ok');
        pendingQrSub = null;
        loadFromServer();                 // non-blocking background refresh
      } else {
        await loadFromServer();           // not cached (first load) — must fetch first
        const found = subs.find(s => s.id === pendingQrSub);
        if(found){ await selectSub(found.id); toast('📍 เปิด ' + found.id + ' จาก QR','ok'); }
        else{ toast('ไม่พบ Meter: ' + pendingQrSub + ' (ลองรีเฟรช)','err'); }
        pendingQrSub = null;
      }
    } else {
      await loadFromServer();
      showRecorderLogin();
    }
  } else {
    loadFromServer();
  }
}

function renderAll(){
  if(!DEBUG_PERF){
    renderZoneAreas(); renderData(); renderStats(); populateDDs(); updateBadge();
    if(activeSub){ updateMeterSummary(); renderRecent(); }
    return;
  }
  const seg = (name, fn) => { const l=perfLabel('renderAll:'+name); perfStart(l); fn(); perfEnd(l); };
  const _t0 = performance.now();
  seg('zoneAreas', renderZoneAreas);
  seg('data',      renderData);
  seg('stats',     renderStats);
  seg('populateDDs', populateDDs);
  seg('updateBadge', updateBadge);
  if(activeSub){ seg('meterSummary', updateMeterSummary); seg('recent', renderRecent); }
  console.log(`⏱ renderAll TOTAL: ${(performance.now()-_t0).toFixed(2)} ms`);
}

const TAB_ORDER = {{TAB_ORDER}};
function goTab(name){
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t   => t.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  const idx   = TAB_ORDER.indexOf(name);
  const tabEl = document.querySelectorAll('.tab')[idx];
  if(tabEl) tabEl.classList.add('active');
  if(name === 'data')     { renderData(); renderStats(); updateRecordWindowNotice(); }
  if(name === 'chart')    { populateDDs(); setSubQuick('30d'); buildCompareGroupOptions(); initG9Pickers(); renderG9Chart(); }
  if(name === 'qr')       { renderQR(); }
  if(name === 'settings') { renderSubList(); renderCalendarList(); }
  if(name === 'summary')  { onTabSummary(); }
  if(name === 'cost')     { onTabCost(); }
}

/* ════════════ WORK CALENDAR ════════════ */
function getDayType(dateStr){
  const found = workCalendar.find(c => c.date === dateStr);
  if(found) return found.type;
  const [y,m,d] = String(dateStr).split('-').map(Number);
  const dow = new Date(y, m-1, d).getDay();
  return (dow === 0 || dow === 6) ? 'holiday' : 'work';
}
function getDayNote(dateStr){ return workCalendar.find(c => c.date === dateStr)?.note || ''; }
async function addCalendarDay(){
  const date = document.getElementById('cal-date').value;
  const type = document.getElementById('cal-type').value;
  const note = document.getElementById('cal-note').value.trim();
  if(!date) return toast('เลือกวันที่ด้วย','err');
  const idx = workCalendar.findIndex(c => c.date === date);
  if(idx >= 0) workCalendar[idx] = { date, type, note }; else workCalendar.push({ date, type, note });
  persist(); renderCalendarList();
  document.getElementById('cal-date').value = ''; document.getElementById('cal-note').value = '';
  toast('✅ เพิ่มวันพิเศษแล้ว','ok');
  try{ await apiPostAuthed({ action:'setCalendarDay', date, type, note }); invalidateSummaryCache('setCalendarDay:'+date); }catch(e){ toast('⚠️ Sync ปฏิทินล้มเหลว: ' + e.message,'warn'); }
}
async function removeCalendarDay(date){
  if(!confirm(`ลบวันพิเศษ ${fmtDate(date)}?`)) return;
  workCalendar = workCalendar.filter(c => c.date !== date);
  persist(); renderCalendarList(); toast('ลบแล้ว');
  try{ await apiPostAuthed({ action:'deleteCalendarDay', date }); invalidateSummaryCache('deleteCalendarDay:'+date); }catch(e){}
}
function renderCalendarList(){
  const box = document.getElementById('cal-list');
  if(!box) return;
  if(!workCalendar.length){ box.innerHTML = '<div class="section-empty">ยังไม่มีวันพิเศษ</div>'; return; }
  const sorted = [...workCalendar].sort((a,b) => b.date.localeCompare(a.date));
  box.innerHTML = sorted.map(c => `<div class="sub-row">
    <div class="sub-row-info">
      <div class="sub-row-id" style="color:${c.type==='work'?'var(--green)':'var(--orange)'}">${fmtDate(c.date)} · ${c.type==='work'?'🟢 ทำงาน':'🔴 หยุด'}</div>
      <div class="sub-row-meta">${esc(c.note)||'—'}</div>
    </div>
    <div class="sub-row-actions"><button class="btn btn-danger btn-sm" onclick="removeCalendarDay('${c.date}')">🗑</button></div>
  </div>`).join('');
}

/* ════════════ PAGINATION ════════════ */
function onPageSizeChange(){ pageSize = parseInt(document.getElementById('pageSize').value); currentPage = 1; renderTable(); }
function renderPaginationControls(totalItems){
  const nav = document.getElementById('pageNav');
  if(!nav) return;
  nav.innerHTML = '';
  const totalPages = Math.ceil(totalItems / pageSize);
  if(totalPages <= 1) return;
  const prevBtn = document.createElement('button');
  prevBtn.className = 'page-btn'; prevBtn.textContent = '◀'; prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => { currentPage--; renderTable(); };
  nav.appendChild(prevBtn);
  for(let i = 1; i <= totalPages; i++){
    if(i === 1 || i === totalPages || (i >= currentPage-2 && i <= currentPage+2)){
      const pBtn = document.createElement('button');
      pBtn.className = `page-btn ${i === currentPage ? 'active' : ''}`; pBtn.textContent = i;
      pBtn.onclick = () => { currentPage = i; renderTable(); };
      nav.appendChild(pBtn);
    } else if(i === currentPage-3 || i === currentPage+3){
      const dot = document.createElement('span'); dot.textContent = '...'; dot.style.color = '#4e6a8a'; nav.appendChild(dot);
    }
  }
  const nextBtn = document.createElement('button');
  nextBtn.className = 'page-btn'; nextBtn.textContent = '▶'; nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => { currentPage++; renderTable(); };
  nav.appendChild(nextBtn);
}
function renderTable(){
  const _plT = perfLabel('renderTable(rows='+filteredRecords.length+')'); perfStart(_plT);
  const tbody    = document.getElementById('main-body');
  const emptyBox = document.getElementById('main-empty');
  if(!tbody || !emptyBox) { perfEnd(_plT); return; }
  tbody.innerHTML = '';
  const total    = filteredRecords.length;
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx   = Math.min(startIdx + pageSize, total);
  const pageItems = filteredRecords.slice(startIdx, endIdx);
  if(document.getElementById('totalRows')) document.getElementById('totalRows').textContent = total;
  if(document.getElementById('rowStart'))  document.getElementById('rowStart').textContent  = total > 0 ? startIdx+1 : 0;
  if(document.getElementById('rowEnd'))    document.getElementById('rowEnd').textContent    = endIdx;
  const count = document.getElementById('data-count');
  if(count) count.textContent = `(${total} รายการ${isFilterActive() ? ' — filtered' : ''})`;
  const badge = document.getElementById('filter-badge');
  if(badge) badge.style.display = isFilterActive() ? 'inline-flex' : 'none';
  if(total === 0){ emptyBox.style.display = 'block'; if(document.getElementById('pageNav')) document.getElementById('pageNav').innerHTML = ''; perfEnd(_plT); return; }
  emptyBox.style.display = 'none';
  tbody.innerHTML = pageItems.map(r => `<tr>
    <td class="td-sub">${r.meterId}</td><td>${fmtDate(r.date)}</td><td>${fmtTime(r.time)}</td>
    <td class="td-kwh">${fmtNum(r.kwh, r.meterId)}</td>
    <td class="td-used"><strong>${fmtUsedCell(r.used, r.meterId)}</strong></td>
    <td class="desktop-only">${esc(r.user)||'—'}</td><td class="desktop-only">${esc(r.note)||'—'}</td>
    <td><div class="td-act">
      <button class="btn btn-primary btn-sm" onclick="openEdit('${r.id}')">✏️</button>
      <button class="btn btn-danger btn-sm"  onclick="deleteRecord('${r.id}')">🗑</button>
    </div></td></tr>`).join('');
  renderPaginationControls(total);
  perfEnd(_plT);
}

/* ════════════ ZONES & SUB SELECTION ════════════ */
function renderZoneAreas(){
  const note = document.getElementById('logging-day-note');
  if(note){
    if(loggingDayLabel){
      note.style.display = 'block';
      note.textContent = 'สถานะสี = รอบจดของวันที่ ' + fmtDate(loggingDayLabel) + ' (รอบเปลี่ยน 16:30)';
    } else {
      note.style.display = 'none';
    }
  }
  const container = document.getElementById('zone-areas');
  container.innerHTML = '';
  if(!subs.length){
    container.innerHTML = `<div class="section-empty" style="padding:30px">
      <div style="font-size:24px;margin-bottom:8px">⏳</div>
      กำลังโหลดรายการ Meter...<br>
      <small style="color:var(--text-3)">ถ้าค้างนาน กด Refresh</small>
    </div>`;
    return;
  }
  // Group meters by their display `zone` field (decoupled from report groups).
  // Section order follows _REPORT_GROUPS, then any unknown zones, then "อื่นๆ".
  const grouped = {}; const order = [];
  function bucket(key){ if(!(key in grouped)){ grouped[key] = []; order.push(key); } return grouped[key]; }
  reportGroups.forEach(g => { if(g.key) bucket(g.key); });           // seed order
  subs.forEach(s => {
    const z = (s.zone && String(s.zone).trim()) ? String(s.zone).trim() : '__OTHER__';
    bucket(z).push(s);
  });
  order.forEach(key => {
    const list = grouped[key];
    if(!list || !list.length) return;                                // skip empty seeded groups
    const label = key === '__OTHER__' ? 'อื่นๆ' : zoneName(key);
    const icon  = key === '__OTHER__' ? '📦'   : zoneIcon(key);
    const block = document.createElement('div');
    block.className = 'zone-block';
    block.innerHTML = `<div class="zone-title"><span class="zt-icon">${icon}</span><span class="zt-name">${esc(label)}</span><span class="zt-count">${list.length}</span></div>`;
    const grid = document.createElement('div');
    grid.className = 'sub-grid';
    list.forEach(s => {
      const recordedToday = !!meterStatusToday[s.id];
      const isSel = activeSub && activeSub.id === s.id;
      const d = document.createElement('div');
      d.className = 'sub-card' + (isSel ? ' sel' : '') + (recordedToday ? ' today' : '');
      d.innerHTML = `
        <div class="sc-id">${esc(s.id)}</div>
        <div class="sc-name">${esc(s.name)}</div>
        <div class="sc-status-row">
          <span class="sc-status-dot"></span>
          <span class="sc-status-txt">${recordedToday ? 'บันทึกแล้ววันนี้' : 'ยังไม่บันทึกวันนี้'}</span>
        </div>`;
      d.onclick = () => selectSub(s.id);
      grid.appendChild(d);
    });
    block.appendChild(grid);
    container.appendChild(block);
  });
}
let historyLoadFailed = false;   // true when the per-meter history fetch failed

/* Reflect a failed history load in the entry screen: the save controls are
   disabled and an explicit retry is offered, rather than letting the person
   record a value with no previous reading to validate against. */
/* The reading label is per-meter, not global: a demand register is read in
   kW and a tap counter in events, so calling everything "kWh สะสม" mislabels
   them. Unit text comes from the meter's own `unit` column, so it can be
   corrected in the sheet without touching code. */
function applyReadingLabel(){
  const el = document.getElementById('in-kwh-label');
  if(!el || !activeSub) return;
  const unit = String(activeSub.unit || '').trim();
  const vt = activeValueType();
  let txt;
  if(vt === 'demand')       txt = `ค่าที่อ่านได้ (${unit || 'kW'})`;
  else if(vt === 'counter') txt = `ค่าที่อ่านได้ (${unit || 'ครั้ง'})`;
  else if(vt === 'snapshot')txt = `ค่าที่อ่านได้ (${unit || 'หน่วยตามมิเตอร์'})`;
  else                      txt = `ค่าที่อ่านได้ (${unit || UNIT} สะสม)`;
  el.innerHTML = '📟 ' + esc(txt);
}

function applyHistoryLoadState(){
  const box = document.getElementById('history-error-box');
  if(box) box.style.display = historyLoadFailed ? 'block' : 'none';
  const sb = document.getElementById('save-btn');
  const ub = document.getElementById('unable-btn');
  if(historyLoadFailed){
    if(sb){ sb.disabled = true; sb.innerHTML = '⛔ โหลดประวัติไม่ได้'; }
    if(ub){ ub.disabled = true; }
  } else if(!window.__writeLocked){
    if(sb){ sb.disabled = false; sb.innerHTML = '✅ บันทึกข้อมูล'; }
    if(ub){ ub.disabled = false; }
  }
}
async function retryLoadHistory(){
  if(!activeSub) return;
  const box = document.getElementById('history-error-box');
  if(box) box.innerHTML = '⏳ กำลังโหลดประวัติอีกครั้ง...';
  try{
    activeSubRecent = await loadRecentForSub(activeSub.id, 5);
    historyLoadFailed = false;
    toast('✅ โหลดประวัติสำเร็จ','ok');
  }catch(e){
    historyLoadFailed = true;
    toast('❌ ยังโหลดประวัติไม่ได้','err');
  }
  if(box) box.innerHTML = '❌ โหลดประวัติมิเตอร์ไม่ได้ จึงยังบันทึกไม่ได้ (ระบบต้องมีค่าครั้งก่อนเพื่อตรวจสอบความถูกต้อง) <button class="btn btn-sm btn-yellow" style="margin-left:8px" onclick="retryLoadHistory()">🔄 ลองใหม่</button>';
  applyHistoryLoadState(); updateMeterSummary(); renderRecent();
}

async function selectSub(meterId){
  activeSub = subs.find(s => s.id === meterId);
  if(!activeSub) return;
  document.getElementById('sub-list-screen').style.display = 'none';
  document.getElementById('entry-section').style.display  = 'block';
  document.getElementById('banner-name').textContent = activeSub.name;
  document.getElementById('banner-id').textContent   = `${activeSub.id} · ${zoneName(activeSub.zone)}`;
  const inKwh = document.getElementById('in-kwh');
  const dec   = activeSub.decimal !== undefined ? activeSub.decimal : 0;
  inKwh.value = '';
  if(dec === 0){ inKwh.setAttribute('step','1'); inKwh.setAttribute('placeholder','กรอกเลขจำนวนเต็มเท่านั้น'); }
  else { inKwh.setAttribute('step',(1/Math.pow(10,dec)).toString()); inKwh.setAttribute('placeholder',`กรอกทศนิยม ${dec} ตำแหน่ง`); }
  const inUser = document.getElementById('in-user');
  if(inUser && currentUser && !inUser.value) inUser.value = currentUser;
  document.getElementById('in-note').value = '';
  document.getElementById('preview-box').style.display = 'none';
  setNow();
  const sb = document.getElementById('save-btn');
  sb.disabled  = true;
  sb.innerHTML = '⏳ กำลังโหลดประวัติมิเตอร์...';
  activeSubRecent = [];
  updateMeterSummary(); renderRecent(); renderZoneAreas();
  // History load must succeed before entry is allowed. If it fails, the app
  // has no previous reading to compare against, so BOTH safety checks are
  // silently disabled — "value lower than last" and "abnormally high vs
  // average". Worse, an empty activeSubRecent is indistinguishable from a
  // genuinely new meter, so the UI would cheerfully say "first reading for
  // this meter" and accept a mistyped number. Block the save instead.
  historyLoadFailed = false;
  // Served from the bulk set when available — no network call on meter open.
  if(bulkRecent && Object.prototype.hasOwnProperty.call(bulkRecent, activeSub.id)){
    activeSubRecent = bulkRecent[activeSub.id] || [];
    applyReadingLabel();
    applyHistoryLoadState(); updateMeterSummary(); renderRecent();
    const sbFast = document.getElementById('save-btn');
    if(sbFast){ sbFast.innerHTML = isConnected ? '✅ บันทึกข้อมูล' : '⚠️ บันทึก (Offline)'; sbFast.disabled = false; }
    return;
  }
  try{
    activeSubRecent = await loadRecentForSub(activeSub.id, 5);
  }catch(e){
    historyLoadFailed = true;
    activeSubRecent = [];
    toast('❌ โหลดประวัติมิเตอร์ไม่ได้ — ยังบันทึกไม่ได้','err');
  }
  sb.innerHTML = isConnected ? '✅ บันทึกข้อมูล' : '⚠️ บันทึก (Offline)';
  sb.disabled  = false;
  applyReadingLabel();
  applyHistoryLoadState();
  updateMeterSummary(); renderRecent();
}
function backToList(){
  activeSub = null;
  activeSubRecent = [];
  document.getElementById('sub-list-screen').style.display = 'block';
  document.getElementById('entry-section').style.display   = 'none';
  renderZoneAreas();
}
function updateMeterSummary(){
  if(!activeSub) return;
  const sm = document.getElementById('meter-summary');
  if(!activeSubRecent.length){ sm.style.display = 'none'; return; }
  sm.style.display = 'block';
  const last = activeSubRecent[0];
  const prev = activeSubRecent.length > 1 ? activeSubRecent[1] : null;
  document.getElementById('last-reading').textContent = fmtNum(last.kwh, activeSub.id);
  document.getElementById('prev-reading').textContent = prev ? fmtNum(prev.kwh, activeSub.id) : '—';
  // For a demand or snapshot meter there is no "used since last time" to show.
  const _lu = document.getElementById('last-used');
  const _vt = activeValueType();
  if(_vt === 'demand' || _vt === 'snapshot'){
    _lu.textContent = '—';
  } else {
    _lu.textContent = (prev && prev.used !== null && prev.used !== undefined)
      ? fmtNum(prev.used, activeSub.id) : '—';
  }
}
/* ── Meter value types ──
   Mirrors VALUE_TYPES in Code.gs. A blank/unknown value means 'cumulative',
   so the 66 existing meters keep behaving exactly as before.
     cumulative — a totalising register; usage = difference between readings
     demand     — kW peak that holds its highest value for the billing cycle
                  and resets monthly; the difference between readings is
                  meaningless, the monthly MAXIMUM is the figure that matters
     counter    — an event count (e.g. OLTC tap changes); difference is valid
                  but it is a count, never energy, so it must stay out of kWh
     snapshot   — an instantaneous value recorded for reference only          */
function meterValueType(meter){
  const t = String((meter && meter.valueType) || '').trim().toLowerCase();
  return ['cumulative','demand','counter','snapshot'].indexOf(t) >= 0 ? t : 'cumulative';
}
function activeValueType(){ return meterValueType(activeSub); }

/* Peak-so-far for a demand meter within the current month, from the readings
   already loaded for this meter. Lets the recorder see at a glance whether the
   figure in front of them sets a new monthly peak. */
function demandPeakThisMonth(){
  const ym = ymdLocal().slice(0,7);   // local month, matching the sheet's dates
  let peak = null, peakDate = null;
  (activeSubRecent || []).forEach(r => {
    if(String(r.date || '').slice(0,7) !== ym) return;
    const v = parseFloat(r.kwh);
    if(isNaN(v)) return;
    if(peak === null || v > peak){ peak = v; peakDate = r.date; }
  });
  return { peak, peakDate };
}

function previewUsed(){
  if(!activeSub) return;
  const val  = parseFloat(document.getElementById('in-kwh').value);
  const box  = document.getElementById('preview-box');
  const chip = document.getElementById('preview-chip');
  if(isNaN(val) || val < 0){ box.style.display = 'none'; return; }
  const lastKwh    = activeSubRecent.length ? (parseFloat(activeSubRecent[0].kwh) || 0) : null;
  const multiplier = activeSub.multiplier !== undefined ? parseFloat(activeSub.multiplier) : 1;
  const vtype = activeValueType();
  box.style.display = 'block';

  if(vtype === 'demand'){
    // No difference is shown: for a demand register the reading IS the value.
    // What the recorder needs to know is whether it beats this month's peak.
    const pk = demandPeakThisMonth();
    if(pk.peak === null){
      chip.className = 'chip chip-green';
      chip.textContent = activeSubRecent.length
        ? `📌 ค่าแรกของเดือนนี้: ${fmtNum(val, activeSub.id)}`
        : `📌 ค่าแรกของมิเตอร์นี้: ${fmtNum(val, activeSub.id)}`;
    } else if(val > pk.peak){
      chip.className = 'chip chip-orange';
      chip.textContent = `🔺 พีคใหม่ของเดือน! เดิม ${fmtNum(pk.peak, activeSub.id)} (${fmtDate(pk.peakDate)})`;
    } else {
      chip.className = 'chip chip-green';
      chip.textContent = `✅ ไม่เกินพีคเดือนนี้ (${fmtNum(pk.peak, activeSub.id)} เมื่อ ${fmtDate(pk.peakDate)})`;
    }
    return;
  }

  if(vtype === 'counter'){
    if(lastKwh === null){ chip.className='chip chip-green'; chip.textContent='📌 บันทึกครั้งแรกของ Meter นี้'; return; }
    const times = val - lastKwh;
    if(times < 0){ chip.className='chip chip-orange'; chip.textContent=`⚠️ ค่าน้อยกว่าครั้งก่อน (${fmtNum(lastKwh, activeSub.id)})`; }
    else { chip.className='chip chip-green'; chip.textContent = times === 0 ? '➖ ไม่เปลี่ยนแปลงจากครั้งก่อน' : `🔁 เพิ่มขึ้น ${Math.round(times).toLocaleString()} ครั้ง`; }
    return;
  }

  if(vtype === 'snapshot'){
    chip.className='chip chip-green';
    chip.textContent = lastKwh === null ? '📌 บันทึกครั้งแรกของ Meter นี้'
                                        : `📄 ค่าครั้งก่อน: ${fmtNum(lastKwh, activeSub.id)}`;
    return;
  }

  if(lastKwh === null){ chip.className = 'chip chip-green'; chip.textContent = '📌 บันทึกครั้งแรกของ Meter นี้'; }
  else {
    const diff = (val - lastKwh) * multiplier;
    chip.className = diff >= 0 ? 'chip chip-green' : 'chip chip-orange';
    chip.textContent = diff >= 0 ? `⚡ ใช้ไฟฟ้าไปรอบนี้: +${fmtNum(diff, activeSub.id)} ${UNIT}` : `⚠️ ค่าน้อยกว่าครั้งก่อน (${fmtNum(lastKwh, activeSub.id)})`;
  }
}
function renderRecent(){
  if(!activeSub) return;
  const recs = activeSubRecent;
  const card = document.getElementById('recent-card');
  const body = document.getElementById('recent-body');
  if(!recs.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';
  const canEdit = appMode === 'admin';
  body.innerHTML = recs.map(r => `<tr>
    <td>${fmtDate(r.date)}</td><td>${fmtTime(r.time)}</td>
    <td class="td-kwh">${fmtNum(r.kwh, activeSub.id)}</td>
    <td class="td-used">${fmtUsedCell(r.used, activeSub.id)}</td>
    <td>${esc(r.user)||'—'}</td>
    <td>${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="openEdit('${r.id}')">✏️</button>` : ''}</td>
  </tr>`).join('');
}

/* ════════════ SAVE RECORD ════════════ */
async function saveRecord(){
  if(!activeSub) return toast('เลือก Meter ก่อน','err');
  const kwh  = parseFloat(document.getElementById('in-kwh').value);
  if(isNaN(kwh) || kwh < 0) return toast('กรอกค่ามิเตอร์ด้วย','err');
  const user = document.getElementById('in-user').value.trim();
  if(!user) return toast('กรอกชื่อผู้บันทึกด้วย','err');
  const date = document.getElementById('in-date').value;
  if(!date) return toast('เลือกวันที่ด้วย','err');
  const time = document.getElementById('in-time').value;
  const note = document.getElementById('in-note').value || '';
  const dupe = activeSubRecent.find(r => r.date === date);
  if(dupe){ if(!confirm(`⚠️ Meter ${activeSub.id} วันที่ ${fmtDate(date)} มีการบันทึกแล้ว (${fmtNum(dupe.kwh, activeSub.id)} kWh)\nบันทึกเพิ่มอีกหรือไม่?`)) return; }
  const lastKwh = activeSubRecent.length ? (parseFloat(activeSubRecent[0].kwh) || 0) : null;
  const vtype = activeValueType();

  /* Validation depends on what kind of register this is.
     A demand meter holds its peak for the whole billing cycle, so an
     unchanged reading is the NORMAL case — real data shows the same value for
     22 days running. Prompting on every one of those would train the recorder
     to dismiss the dialog without reading it, and the genuine mistakes would
     be waved through with the rest. Same for a tap-change counter, which
     often does not move for days. For those two, only a DECREASE is worth
     interrupting for: it means either a misread or a cycle reset. */
  if(lastKwh !== null && kwh < lastKwh){
    const msg = (vtype === 'demand')
      ? `ค่าที่กรอก (${kwh}) น้อยกว่าครั้งก่อน (${lastKwh})\n\nถ้าเป็นต้นรอบบิลใหม่ (มิเตอร์เพิ่งรีเซ็ต) ถือว่าปกติ\nบันทึกต่อหรือไม่?`
      : `ค่าที่กรอก (${kwh}) น้อยกว่าครั้งก่อน (${lastKwh})\nบันทึกต่อหรือไม่?`;
    if(!confirm(msg)) return;
  }

  // The "abnormally high" check compares consumption deltas, which only mean
  // something for a totalising register.
  if(vtype === 'cumulative' && lastKwh !== null && kwh > lastKwh){
    const multiplier = activeSub.multiplier !== undefined ? parseFloat(activeSub.multiplier) : 1;
    const diff       = (kwh - lastKwh) * multiplier;
    const recentUsed = getRecentAvgUsed(activeSub.id);
    if(recentUsed > 0 && diff > recentUsed * ABNORMAL_MULTIPLIER){
      if(!confirm(`⚠️ ค่าที่ใช้รอบนี้ (${Math.round(diff).toLocaleString()}) สูงผิดปกติ\nมากกว่าค่าเฉลี่ยที่ผ่านมา (${Math.round(recentUsed).toLocaleString()}) เกิน ${ABNORMAL_MULTIPLIER} เท่า\n\nกรอกค่าผิดหรือไม่? ยืนยันบันทึก?`)) return;
    }
  }
  await doSaveRecord(activeSub, kwh, date, time, user, note);
}
async function doSaveRecord(sub, kwh, date, time, user, note){
  const now = new Date();
  const rec = { id: `REC-${now.getTime()}-${Math.floor(Math.random()*1000)}`, meterId: sub.id, meterName: sub.name, zone: sub.zone, date, time, kwh, user, note, ts: now.toISOString(), editedTs: '', editedBy: '' };
  // Remember the pre-save state so a failed write can be rolled back cleanly.
  // NOTE: nothing is queued locally for a recorder — if the POST fails the
  // reading is genuinely gone, so we must NOT clear the form or claim success
  // until the server has confirmed. (The old code did both up-front and told
  // the user "saved on device", which was untrue for recorders and could let
  // a lost reading pass unnoticed.)
  const prevStatus      = meterStatus[sub.id];
  const prevStatusToday = meterStatusToday[sub.id];
  if(appMode === 'admin' && records.length){ records.push(rec); records = computeUsed(records); persist(); }
  meterStatus[sub.id] = true;
  meterStatusToday[sub.id] = true;   // this is what drives the green/red card
  renderZoneAreas(); updateBadge();
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = '⏳ กำลังบันทึก...';
  setSyncStatus('busy','กำลังบันทึกลง Google Sheets...');
  try{
    const payload = { id:rec.id, meterId:rec.meterId, meterName:rec.meterName, zone:rec.zone, date:rec.date, time:rec.time, kwh:rec.kwh, user:rec.user, note:rec.note, ts:rec.ts, editedTs:'', editedBy:'' };
    const res = await apiPost({ action:'saveRecord', record:payload, token: sessionToken });
    if(!res || res.success === false) throw new Error((res && res.error) || 'บันทึกไม่สำเร็จ');
    invalidateSummaryCache('saveRecord:'+rec.meterId+'@'+rec.date);
    // Confirmed by the server — only now is it safe to clear the form.
    toast('✅ บันทึกแล้ว','ok');
    document.getElementById('in-kwh').value  = '';
    document.getElementById('in-note').value = '';
    document.getElementById('preview-box').style.display = 'none';
    setNow();
    setSyncStatus('ok','บันทึกลง Sheets แล้ว');
    if(activeSub && activeSub.id === sub.id){
      try{
        activeSubRecent = await loadRecentForSub(sub.id, 5);
        if(bulkRecent) bulkRecent[sub.id] = activeSubRecent;   // keep the bulk set in step
      }catch(e){}
      updateMeterSummary(); renderRecent();
    }
  }catch(e){
    // Roll back the optimistic state: the card goes back to red and the value
    // the person typed stays in the box so they can just press save again.
    meterStatus[sub.id]      = prevStatus;
    meterStatusToday[sub.id] = prevStatusToday;
    if(appMode === 'admin' && records.length){
      records = records.filter(r => r.id !== rec.id);
      records = computeUsed(records); persist();
    }
    renderZoneAreas(); updateBadge();
    const isAuthFailure = /เซสชัน|เข้าสู่ระบบ/.test(e.message || '');
    if(isAuthFailure){
      setSyncStatus('error','เซสชันหมดอายุ — ยังไม่ได้บันทึก');
      toast('❌ เซสชันหมดอายุ ยังไม่ได้บันทึก — เข้าสู่ระบบใหม่แล้วกดบันทึกอีกครั้ง','err');
      showSessionExpiredBanner();
    } else {
      setSyncStatus('error','บันทึกไม่สำเร็จ');
      toast('❌ บันทึกไม่สำเร็จ กรุณาลองใหม่ (ค่าที่กรอกยังอยู่)','err');
    }
  }finally{ btn.disabled = false; btn.innerHTML = '✅ บันทึกข้อมูล'; }
}
function getRecentAvgUsed(meterId){
  // Only real consumption figures feed the "abnormally high" check. Entries
  // with a null `used` (demand/snapshot) are excluded explicitly rather than
  // relying on null||0 falling below the > 0 test.
  const chain = activeSubRecent.filter(r => r.used !== null && r.used !== undefined && r.used > 0);
  if(!chain.length) return 0;
  return chain.reduce((a,r) => a + r.used, 0) / chain.length;
}
async function markUnableToRecord(){
  if(!activeSub) return toast('เลือก Meter ก่อน','err');
  const lastRec = activeSubRecent[0];
  if(!lastRec){ return toast('⚠️ ยังไม่มีค่ามิเตอร์ก่อนหน้า ไม่สามารถใช้ฟังก์ชันนี้ได้','err'); }
  const reason = prompt('📝 ระบุเหตุผลที่จดไม่ได้:\n(เช่น มิเตอร์เสีย, เข้าพื้นที่ไม่ได้)', 'ไม่สามารถบันทึกค่าได้');
  if(reason === null) return;
  const date = document.getElementById('in-date').value;
  if(!confirm(`ยืนยันว่า Meter ${activeSub.id} วันที่ ${fmtDate(date)} จดไม่ได้?\n\nระบบจะใช้ค่าเดิม ${fmtNum(lastRec.kwh, activeSub.id)} kWh\nหมายเหตุ: ${reason}`)) return;
  const user = document.getElementById('in-user').value.trim() || currentUser || 'ไม่ระบุ';
  const time = document.getElementById('in-time').value;
  await doSaveRecord(activeSub, parseFloat(lastRec.kwh), date, time, user, '⚠️ ' + reason);
  toast('📌 บันทึกว่าจดไม่ได้แล้ว','warn');
}

/* ════════════ EDIT / DELETE RECORD ════════════ */
function openEdit(recordId){
  const r = records.find(x => x.id === recordId);
  if(!r) return toast('❌ ไม่พบข้อมูลรายการนี้','err');
  currentEditingRecordId = recordId;
  const editSubSelect = document.getElementById('edit-sub');
  editSubSelect.innerHTML = subs.map(s => `<option value="${s.id}" ${s.id === r.meterId ? 'selected' : ''}>${s.id} — ${s.name}</option>`).join('');
  document.getElementById('edit-kwh').value  = r.kwh;
  document.getElementById('edit-date').value = r.date;
  document.getElementById('edit-time').value = r.time || '';
  document.getElementById('edit-user').value = r.user || '';
  document.getElementById('edit-note').value = r.note || '';
  updateEditKwhStep(r.meterId);
  editSubSelect.onchange = e => updateEditKwhStep(e.target.value);
  const modal = document.getElementById('edit-modal');
  modal.style.display = 'flex'; modal.classList.add('open');
}
function updateEditKwhStep(meterId){
  const sub      = subs.find(s => s.id === meterId);
  const dec      = sub?.decimal !== undefined ? sub.decimal : 0;
  const inputKwh = document.getElementById('edit-kwh');
  if(dec === 0){ inputKwh.setAttribute('step','1'); inputKwh.setAttribute('placeholder','กรอกเลขจำนวนเต็มเท่านั้น'); }
  else { inputKwh.setAttribute('step',(1/Math.pow(10,dec)).toString()); inputKwh.setAttribute('placeholder',`กรอกทศนิยม ${dec} ตำแหน่ง`); }
}
function closeEdit(){ currentEditingRecordId = null; const modal = document.getElementById('edit-modal'); modal.style.display = 'none'; modal.classList.remove('open'); }
function closeEditIf(event){ if(event.target.id === 'edit-modal') closeEdit(); }
/* Everything here addresses records by id, never by array position.
   computeUsed() rebuilds the array by grouping per meter, so an index taken
   before it points at a different record afterwards. The old code captured
   `idx` up front and then used it both to read back what to send to the server
   AND to roll back on failure — so a failed edit could transmit one record's
   values under another record's id, and the rollback would overwrite a third,
   unrelated record. */
async function saveEdit(){
  if(!currentEditingRecordId) return;
  const recordId = currentEditingRecordId;
  const target = records.find(r => r.id === recordId);
  if(!target) return toast('❌ ไม่พบรายการ','err');
  const newSubId = document.getElementById('edit-sub').value;
  const kwh      = parseFloat(document.getElementById('edit-kwh').value);
  const date     = document.getElementById('edit-date').value;
  const time     = document.getElementById('edit-time').value;
  const user     = document.getElementById('edit-user').value.trim();
  const note     = document.getElementById('edit-note').value;
  if(isNaN(kwh) || kwh < 0) return toast('กรอกค่ามิเตอร์ให้ถูกต้อง','err');
  if(!date) return toast('เลือกวันที่ด้วย','err');
  const sub = subs.find(s => s.id === newSubId);
  const originalRecord = { ...target };

  // Mutate the object itself — it keeps its identity through computeUsed()'s
  // regrouping, so no position needs tracking.
  target.meterId   = newSubId;
  target.meterName = sub?.name || target.meterName;
  target.zone      = sub?.zone || target.zone;
  target.kwh       = kwh;
  target.date      = date;
  target.time      = time;
  target.user      = user;
  target.note      = note;
  target.editedTs  = new Date().toISOString();
  target.editedBy  = currentUser || 'ผู้บันทึก';

  records = computeUsed(records); persist();
  const saved = records.find(r => r.id === recordId) || target;
  closeEdit(); renderAll(); toast('✅ แก้ไขแล้ว (กำลัง sync...)','ok');
  setSyncStatus('busy','กำลังซิงค์...');
  try{
    const payload = { id:saved.id, meterId:saved.meterId, meterName:saved.meterName, zone:saved.zone, date:saved.date, time:saved.time, kwh:saved.kwh, user:saved.user, note:saved.note, ts:saved.ts, editedTs:saved.editedTs, editedBy:saved.editedBy };
    await apiPostAuthed({ action:'editRecord', record:payload });
    invalidateSummaryCache('editRecord:'+saved.meterId+'@'+saved.date);
    setSyncStatus('ok','แก้ไขสำเร็จ');
  }catch(e){
    // Restore by id: drop whatever now carries this id and put the original back.
    records = records.filter(r => r.id !== recordId);
    records.push(originalRecord);
    records = computeUsed(records); persist(); renderAll();
    setSyncStatus('error','แก้ไขไม่สำเร็จ — ยกเลิกการเปลี่ยนแปลงในเครื่องแล้ว');
  }
}
async function deleteRecord(id){
  if(!confirm('ลบรายการนี้?')) return;
  const target = records.find(r => r.id === id);
  if(!target) return;
  records = records.filter(r => r.id !== id);
  records = computeUsed(records); persist();
  toast('ลบแล้ว (กำลัง sync...)'); renderAll();
  setSyncStatus('busy','กำลังลบจาก Sheets...');
  try{
    await apiPostAuthed({ action:'deleteRecord', id:String(id) });
    invalidateSummaryCache('deleteRecord:'+id);
    setSyncStatus('ok','ลบสำเร็จ');
  }catch(e){
    // Put it back by identity, not by the position it used to occupy:
    // computeUsed() has regrouped the array since, so that index now belongs
    // to a different record and splicing there would corrupt the neighbour.
    records.push(target);
    records = computeUsed(records); persist(); renderAll();
    setSyncStatus('error','ลบไม่สำเร็จ — กู้คืนรายการในเครื่องแล้ว');
  }
}

/* ════════════ EDIT METER ════════════ */
function openEditSub(i){
  editSubIndex = i;
  const s = subs[i];
  document.getElementById('esub-id').value         = s.id;
  document.getElementById('esub-name').value       = s.name;
  document.getElementById('esub-zone').value       = s.zone;
  document.getElementById('esub-decimal').value    = String(s.decimal    !== undefined ? s.decimal    : 0);
  document.getElementById('esub-multiplier').value = String(s.multiplier !== undefined ? s.multiplier : 1);
  const modal = document.getElementById('edit-sub-modal');
  modal.style.display = 'flex'; modal.classList.add('open');
}
function closeEditSub(){ editSubIndex = null; const modal = document.getElementById('edit-sub-modal'); modal.style.display = 'none'; modal.classList.remove('open'); }
function closeEditSubIf(event){ if(event.target.id === 'edit-sub-modal') closeEditSub(); }
async function saveEditSub(){
  if(editSubIndex === null) return;
  const name       = document.getElementById('esub-name').value.trim();
  const zone       = document.getElementById('esub-zone').value.trim();
  const decimal    = parseInt(document.getElementById('esub-decimal').value) || 0;
  const multiplier = parseFloat(document.getElementById('esub-multiplier').value);
  if(!name || !zone) return toast('⚠️ กรุณากรอกชื่อ Meter และ Zone ให้ครบ','err');
  if(!isFinite(multiplier) || multiplier <= 0) return toast('⚠️ ตัวคูณต้องมากกว่า 0','err');
  const updatedSub = { ...subs[editSubIndex], name, zone, decimal, multiplier };
  subs[editSubIndex] = updatedSub; persist(); closeEditSub();
  records = computeUsed(records); persist();
  renderSubList(); renderZoneAreas(); populateDDs(); renderAll();
  toast(`✅ อัปเดต Meter ${updatedSub.id} เรียบร้อย (กำลังซิงค์...)`,'ok');
  setSyncStatus('busy','กำลังซิงค์ลง Google Sheets...');
  try{
    await apiPostAuthed({ action:'updateMeterConfig', meter:updatedSub });
    setSyncStatus('ok','บันทึกข้อมูล Meter ลงแผ่นชีทสำเร็จ');
  }catch(e){ setSyncStatus('error','บันทึกลงชีทไม่สำเร็จ (แต่เซฟเก็บในแคชแล้ว)'); }
}

/* ════════════ FILTER & DATA ════════════ */
function isFilterActive(){ return !!(activeFilter.sub || activeFilter.user || activeFilter.from || activeFilter.to); }
function renderData(){ applyFilter(); }
function applyFilter(){
  const _plF = perfLabel('applyFilter(n='+records.length+')'); perfStart(_plF);
  const subVal   = document.getElementById('fl-sub').value;
  const userVal  = document.getElementById('fl-user')?.value.trim().toLowerCase() || '';
  const startVal = document.getElementById('fl-from').value;
  const endVal   = document.getElementById('fl-to').value;
  const sortVal  = document.getElementById('fl-sort')?.value || 'newest';
  activeFilter = { sub:subVal, user:userVal, from:startVal, to:endVal };
  filteredRecords = records.filter(r => {
    if(subVal   && r.meterId !== subVal) return false;
    if(userVal  && !String(r.user).toLowerCase().includes(userVal)) return false;
    if(startVal && r.date < startVal)  return false;
    if(endVal   && r.date > endVal)    return false;
    return true;
  });
  if(sortVal === 'newest'){
    filteredRecords.sort((a,b) => (b.ts||'').localeCompare(a.ts||''));
  } else if(sortVal === 'date-desc'){
    filteredRecords.sort((a,b) => (`${b.date} ${b.time||'00:00'}`).localeCompare(`${a.date} ${a.time||'00:00'}`));
  } else if(sortVal === 'date-asc'){
    filteredRecords.sort((a,b) => (`${a.date} ${a.time||'00:00'}`).localeCompare(`${b.date} ${b.time||'00:00'}`));
  } else if(sortVal === 'sub-asc'){
    filteredRecords.sort((a,b) => a.meterId.localeCompare(b.meterId) || (`${b.date} ${b.time||'00:00'}`).localeCompare(`${a.date} ${a.time||'00:00'}`));
  }
  perfEnd(_plF);
  currentPage = 1; renderTable();
}
function clearFilter(){
  ['fl-sub','fl-user','fl-from','fl-to'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  const sortEl = document.getElementById('fl-sort');
  if(sortEl) sortEl.value = 'newest';
  applyFilter();
}
function populateDDs(){
  const sOpts = '<option value="">ทั้งหมด</option>' + subs.map(s => `<option value="${s.id}"${s.id===activeFilter.sub?' selected':''}>${s.id} — ${s.name}</option>`).join('');
  const cOpts = '<option value="">เลือก Sub...</option>' + subs.map(s => `<option value="${s.id}">${s.id}</option>`).join('');
  document.getElementById('fl-sub').innerHTML = sOpts;
  const cs = document.getElementById('chart-sub');
  if(cs) cs.innerHTML = cOpts;
}
/* The Data-tab stat tiles were removed: after the rolling 90-day record
   window was introduced, three of the four counters (total records,
   meters recorded, total kWh) silently described the loaded window
   rather than the real dataset, which made them misleading. Kept as a
   no-op so the existing call sites need no changes. */
function renderStats(){
  /* The Data-tab stat tiles were removed. Once the admin record window became
     a rolling 90 days, three of the four counters (total records, meters
     recorded, total energy) described the loaded window rather than the real
     dataset, which made them quietly misleading. Kept as a no-op so the three
     existing call sites need no changes; the body is gone rather than left
     unreachable behind a return, so nothing references #stats-row any more. */
}
/* Two elements shared the id "hdr-badge" after the header redesign: a hidden
   leftover in the header and the visible one on the Entry card. getElementById
   returns the first match, so every update landed on the invisible one and the
   badge the user actually sees never changed. The header copy is gone and the
   remaining one has its own id. */
function updateBadge(){
  const el = document.getElementById('entry-record-badge');
  if(el) el.textContent = records.length + ' rec';
}

/* ════════════ QR ════════════ */
function renderQR(){
  const grid = document.getElementById('qr-grid');
  grid.innerHTML = '';
  const zoneSel = document.getElementById('qr-zone-filter');
  if(zoneSel && zoneSel.options.length <= 1){
    const zoneKeys = [...new Set(subs.map(s => s.zone))].sort();
    zoneSel.innerHTML = '<option value="">ทั้งหมด</option>' +
      zoneKeys.map(z => `<option value="${z}">${esc(zoneName(z))}</option>`).join('');
  }
  const filterZone = zoneSel?.value || '';
  const list = filterZone ? subs.filter(s => s.zone === filterZone) : subs;
  if(!list.length){ grid.innerHTML = '<div class="section-empty">ไม่มี Meter ใน Zone นี้</div>'; return; }
  ensureQRCode().catch(function(e){ grid.innerHTML = '<div class="warn-box">❌ โหลด QR library ไม่ได้</div>'; });
  list.forEach(sub => {
    const url = QR_BASE_URL.replace(/\/$/, '') + '?sub=' + encodeURIComponent(sub.id);
    const qid = 'qr_' + sub.id.replace(/\W/g,'_');
    const div = document.createElement('div');
    div.className = 'qr-item';
    div.innerHTML = `<div class="qi-name">${esc(sub.name)}<br><span style="color:var(--purple)">${esc(zoneName(sub.zone))}</span></div><div class="qi-id">${sub.id}</div><div class="qi-qr" id="${qid}"></div><div class="qi-url">${url.length>55 ? url.slice(0,52)+'…' : url}</div>`;
    grid.appendChild(div);
    ensureQRCode().then(function(){
      const elQ = document.getElementById(qid);
      if(!elQ) return;
      try{
        elQ.innerHTML = '';
        new QRCode(elQ, { text:url, width:110, height:110, colorDark:'#000', colorLight:'#fff', correctLevel:QRCode.CorrectLevel.M });
      }catch(e){}
    });
  });
}

/* ════════════ SETTINGS ════════════ */
function renderSubList(){
  document.getElementById('sub-count').textContent = subs.length;
  if(!subs.length){ document.getElementById('sub-list').innerHTML='<div class="section-empty">ยังไม่มี Meter</div>'; return; }
  document.getElementById('sub-list').innerHTML = subs.map((s,i) => {
    const cnt       = records.filter(r => r.meterId === s.id).length;
    const totalUsed = records.filter(r => r.meterId === s.id).reduce((a,r) => a+(parseFloat(r.used)||0), 0);
    const dec       = s.decimal !== undefined ? s.decimal : 0;
    return `<div class="sub-row">
      <div class="sub-row-info">
        <div class="sub-row-name">${esc(s.name)}</div>
        <div class="sub-row-meta"><span class="sub-row-idtag">${s.id}</span> · ${esc(s.zone)} · ${cnt} rec · ${Math.round(totalUsed).toLocaleString()} kWh</div>
        <span class="sub-row-dec">ทศนิยม ${dec} · ×${s.multiplier||1}</span>
      </div>
      <div class="sub-row-actions">
        <button class="btn btn-primary btn-sm" onclick="openEditSub(${i})">✏️</button>
        <button class="btn btn-danger btn-sm"  onclick="removeSub(${i})">🗑</button>
      </div>
    </div>`;
  }).join('');
}
async function addSub(){
  const id      = document.getElementById('new-id').value.trim().toUpperCase();
  const name    = document.getElementById('new-name').value.trim();
  const decimal = parseInt(document.getElementById('new-decimal').value) || 0;
  const zone    = document.getElementById('new-zone').value.trim() || 'Custom';
  if(!id || !name) return toast('กรอก ID และชื่อด้วย','err');
  if(subs.find(s => s.id === id)) return toast('ID นี้มีอยู่แล้ว','err');
  const newSub = { id, name, zone, decimal, multiplier:1, unit:UNIT };
  try{
    await apiPostAuthed({ action:'updateMeterConfig', meter:newSub });
  }catch(e){
    return;
  }
  subs.push(newSub);
  persist();
  ['new-id','new-name','new-zone'].forEach(x => { document.getElementById(x).value=''; });
  document.getElementById('new-decimal').value = '0';
  renderSubList(); renderZoneAreas(); populateDDs();
  toast('✅ เพิ่ม ' + id,'ok');
}
async function removeSub(i){
  const s   = subs[i];
  const cnt = records.filter(r => r.meterId === s.id).length;
  if(cnt > 0){
    toast(`❌ ลบไม่ได้ — ${s.id} มีประวัติการบันทึก ${cnt} รายการอยู่แล้ว (ระบบป้องกันไว้เพื่อไม่ให้ report เก่าคำนวณผิด — เปลี่ยนชื่อ/Zone แทนถ้าต้องการเลิกใช้งาน Meter นี้)`,'err');
    return;
  }
  if(!confirm(`ลบ ${s.id} — ${s.name}?`)) return;
  try{
    await apiPostAuthed({ action:'deleteMeter', id:s.id });
  }catch(e){
    return;
  }
  subs.splice(i, 1); persist();
  renderSubList(); renderZoneAreas(); populateDDs();
  toast('ลบ ' + s.id);
}

/* ════════════ EXPORT / IMPORT ════════════ */
async function exportExcel(){
  const hasFilter    = isFilterActive();
  const dataToExport = hasFilter ? [...filteredRecords] : [...records].reverse();
  if(!dataToExport.length) return toast(hasFilter?'ไม่มีข้อมูลตาม Filter':'ยังไม่มีข้อมูล','err');
  try{ await ensureXLSX(); }catch(e){ return toast('โหลด Excel library ไม่ได้','err'); }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(dataToExport.map(r => ({
    'ID': r.id, 'Meter ID': r.meterId, 'คำอธิบาย': r.meterName, 'หมวด': r.zone,
    'Date': fmtDate(r.date), 'Time': fmtTime(r.time),
    [UNIT + ' (Cumulative)']: fmtNum(r.kwh, r.meterId), ['Used (' + UNIT + ')']: (r.used === null || r.used === undefined) ? '' : fmtNum(r.used, r.meterId),
    'User': r.user, 'Note': r.note, 'Edited By': r.editedBy||'', 'Timestamp': r.ts
  })));
  ws['!cols'] = Array(12).fill({ wch:18 });
  XLSX.utils.book_append_sheet(wb, ws, hasFilter?'Filtered_Records':'All_Records');
  XLSX.writeFile(wb, `Meter_${hasFilter?'Filtered_':''}${new Date().toISOString().slice(0,10)}.xlsx`);
  toast(`✅ Export ${dataToExport.length} rows${hasFilter?' (filtered)':''}`, 'ok');
}
function exportJSON(){
  const blob = new Blob([JSON.stringify({ subs, records, calendar:workCalendar, exported:new Date().toISOString() }, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = APP_NS + '_backup_' + Date.now() + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  toast('💾 Backup สำเร็จ','ok');
}
function doImport(e){
  const file = e.target.files[0]; if(!file) return;
  const r = new FileReader();
  r.onload = ev => {
    try{
      const d = JSON.parse(ev.target.result);
      const imported = d.meters || d.subs;   // accept legacy backup files (old name was 'subs')
      if(imported)   subs         = imported.map(s => ({ ...s, decimal: s.decimal!==undefined?s.decimal:0 }));
      if(d.records)  records      = computeUsed(d.records);
      if(d.calendar) workCalendar = d.calendar;
      currentPage = 1; persist(); renderAll();
      toast(`📂 Import สำเร็จ — ${records.length} records`,'ok');
    }catch(err){ toast('ไฟล์ไม่ถูกต้อง','err'); }
  };
  r.readAsText(file); e.target.value = '';
}
function clearCache(){
  if(!confirm('ล้าง Cache ในเครื่องนี้?\n(ข้อมูลใน Google Sheets ยังอยู่ครบ)')) return;
  records = []; subs = []; workCalendar = []; filteredRecords = []; currentPage = 1;
  lsRemove('records'); lsRemove('subs'); lsRemove('calendar');
  toast('ล้าง Cache แล้ว — กำลังโหลดจาก Sheets ใหม่...','warn');
  loadFromServer();
}

function toast(msg, type=''){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg; t.className = 'on' + (type ? ' '+type : '');
  clearTimeout(t._t); t._t = setTimeout(() => { t.className = ''; }, 3200);
}

document.addEventListener('DOMContentLoaded', () => {
  ['login-user','login-pass'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('keydown', e => { if(e.key === 'Enter') handleLogin(); });
  });
  const recorderPassEl = document.getElementById('recorder-pass');
  if(recorderPassEl) recorderPassEl.addEventListener('keydown', e => { if(e.key === 'Enter') handleRecorderLogin(); });
});

init();




