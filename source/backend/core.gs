// ============================================================
//  WATER METER LOGGER V2 — หลังบ้าน (รหัส.gs)
//  Aug 2026 patch: ports the full security hardening built for the Electric
//  (Substation) sister app onto this Water Meter backend:
//    - Session-token auth (replaces the old ADMIN_SECRET/PROTECTED_ACTIONS
//      mechanism — see note above _requireAdmin() for why this is stronger)
//    - Recorder login (shared team passcode) replacing open/no-login saveRecord
//    - doGet() trimmed to {app, meters, reportGroups, calendar} — full records now admin-gated
//    - Scoped per-meter reads (getMeterStatus, getLastRecord, getRecentRecords)
//    - Password hashing (self-migrating from plaintext)
//    - Login rate limiting
//    - Input validation on addRecord/editRecord
//    - Audit log for anomalies (login failures, rejected auth, bad input)
//    - Caching for getAllMeters/_getMeterRecordChain/getMeterStatus
//    - _readSheetRange() replacing getDataRange() throughout
//    - deleteMeter() blocked when records exist
//  No live data existed in this sheet at time of writing (confirmed with the
//  team before this patch) — so no backward-compatibility constraints applied
//  here beyond what's noted inline.
// ============================================================

// ═══════════════════════════════════════════════════════════
//  CONFIG — the ONLY block that differs between the four apps
//  (Electric/Water × SR/GW). Generating another app = change this block.
// ═══════════════════════════════════════════════════════════
const APP_ID           = '{{APP_ID}}';  // unique per app; doGet returns it so the
                                              // frontend can verify it hit the right backend
const UNIT             = '{{UNIT}}';  // 'm3' (water) or 'kWh' (electric) — default unit
const ADMIN_SEED_PW    = '{{ADMIN_SEED_PW}}';  // CHANGE per app (admin back-office password)
const RECORDER_SEED_PW = '{{RECORDER_SEED_PW}}';  // shared recorder-team passcode (intentionally same)

// ═══════════════════════════════════════════════════════════
//  SHEET TABS — universal naming, identical across all four apps
// ═══════════════════════════════════════════════════════════
const RECORDS_SHEET = '_RECORDS';
const METERS_SHEET  = '_METERS';
const GROUPS_SHEET  = '_REPORT_GROUPS';
const USERS_SHEET   = '_USERS';
const CAL_SHEET     = '_CALENDAR';
const AUDIT_SHEET   = '_AUDITLOG';

const REC_HEADERS   = ['id','meterId','meterName','zone','date','time','kwh','user','note','ts','editedTs','editedBy'];
// valueType is APPENDED, never inserted: every read below is positional, so
// adding a column anywhere but the end shifts existing data. Blank = 'cumulative',
// which is the behaviour every existing meter already had.
const METER_HEADERS = ['id','name','zone','unit','decimal','multiplier','valueType'];

// How a meter's readings should be interpreted:
//   cumulative — an ever-increasing register; consumption = difference between
//                readings. This is the default and covers every meter that
//                existed before this column was introduced.
//   demand     — an instantaneous kW figure that rises and falls and is reset by
//                the utility each billing cycle. Differences are meaningless; what
//                matters is the highest value seen in the month, and when.
//   counter    — an event tally (e.g. tap-changer operations). Differences are
//                valid but are a count, not energy, so it must stay out of kWh totals.
//   snapshot   — a point-in-time value recorded for reference only.
const VALUE_TYPES = ['cumulative','demand','counter','snapshot'];
function _normValueType(v) {
  const t = String(v || '').trim().toLowerCase();
  return VALUE_TYPES.indexOf(t) >= 0 ? t : 'cumulative';
}
const USER_HEADERS  = ['username','password','name','role'];
const CAL_HEADERS   = ['date','type','note'];
const GROUP_HEADERS = ['key','name','icon','color','type','meters','minus'];

const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours — matches Electric app

const LOGIN_MAX_ATTEMPTS    = 5;
const LOGIN_LOCKOUT_SECONDS = 10 * 60; // 10 minutes

// ============================================================
//  doGet
//  Full consumption history (records) is the sensitive data here — plant
//  water usage patterns are reconstructable from it — not the recorder's
//  name. doGet() now exposes only sub config and calendar. Full history is
//  behind admin auth (getRawRecords); basic-mode entry gets only what it
//  needs, scoped to the single meter in front of the person.
// ============================================================
function doGet(e) {
  var result = {};
  try {
    result = {
      status:       'success',
      app:          APP_ID,
      meters:       getAllMeters(),
      reportGroups: getReportGroups(),
      calendar:     getWorkCalendar()
    };
  } catch (error) {
    result = { status: 'error', message: error.toString() };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  doPost
// ============================================================
function doPost(e) {
  var result = {};
  try {
    var data = JSON.parse(e.postData.contents);

    switch (data.action) {

      case 'login': {
        var username = String(data.username || '');
        var lockCheck = _checkLoginLockout(username);
        if (!lockCheck.ok) { result = { success: false, error: lockCheck.error }; break; }

        var loginResult = _attemptLogin(username, String(data.password || ''));
        if (loginResult.found) {
          _clearLoginAttempts(username);
          var token = _createSession(loginResult.user);
          result = { success: true, name: loginResult.user.name, role: loginResult.user.role || 'basic', token: token };
        } else {
          _recordFailedLogin(username);
          result = { success: false, error: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' };
        }
        break;
      }

      case 'logout': {
        // Revokes the token server-side immediately, rather than relying on
        // it to expire naturally over the next (up to) 4 hours.
        if (data.token) _revokeSession(data.token);
        result = { success: true };
        break;
      }

      case 'saveRecord': {
        // Any valid session — recorder or admin — is accepted here; this is
        // NOT admin-only (that's _requireAdmin, used for config/delete below).
        var loginCheck = _requireLoggedIn(data.token);
        if (!loginCheck.ok) { result = { success: false, error: loginCheck.error }; break; }
        if (!data.record) throw new Error('Missing record payload');
        result = addRecord(data.record);
        break;
      }

      case 'getMeterStatus':
        // Open, no login required — returns booleans only (has this meter
        // ever been recorded, yes/no), never numbers.
        result = getMeterStatus(data.meterIds);
        break;

{{BACKEND_CASES}}

      case 'getAvailableMonths':
        // Open, no login required — returns a list of 'YYYY-MM' strings only,
        // no figures. Lets the report pickers offer exactly the months that
        // actually hold data, without the client needing the full record set.
        result = getAvailableMonths();
        break;

      case 'getMetersRecordedToday':
        // Open, no login required — same exposure level as getMeterStatus
        // (booleans only). Returns which meters have a reading dated TODAY
        // (Asia/Bangkok), for the entry-screen red/green status dot.
        result = getMetersRecordedToday(data.meterIds);
        break;

      case 'getRecentRecordsAll': {
        // Login-gated like getRecentRecords — same data, all meters at once.
        var loginCheck = _requireLoggedIn(data.token);
        if (!loginCheck.ok) { result = { success: false, error: loginCheck.error }; break; }
        result = getRecentRecordsAllMeters();
        break;
      }

      case 'getRecentRecords': {
        var loginCheck = _requireLoggedIn(data.token);
        if (!loginCheck.ok) { result = { success: false, error: loginCheck.error }; break; }
        if (!data.meterId) throw new Error('Missing meterId');
        result = getRecentRecordsForMeter(String(data.meterId), data.limit ? parseInt(data.limit) : 5);
        break;
      }

      case 'getRawRecords': {
        // Admin-only — full consumption history across every meter.
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        result = { success: true, records: getAllRecords(data.dateFrom, data.dateTo) };
        break;
      }

      case 'editRecord': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        if (!data.record) throw new Error('Missing record payload');
        result = editRecord(data.record);
        break;
      }

      case 'deleteRecord': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        if (!data.id) throw new Error('Missing record id');
        result = deleteRecord(String(data.id));
        break;
      }

      case 'updateMeterConfig': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        if (!data.meter) throw new Error('Missing meter payload');
        result = updateMeterConfig(data.meter);
        break;
      }

      case 'deleteMeter': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        if (!data.id) throw new Error('Missing meter id');
        result = deleteMeter(String(data.id));
        break;
      }

      case 'getMonthlySummary': {
        // Admin-only — aggregated consumption data, the sensitive thing
        // this whole redesign protects. Previously open to anyone with the URL.
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        result = getMonthlySummary(data.dateFrom, data.dateTo, data.granularity);
        break;
      }

      case 'setCalendarDay': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        if (!data.date || !data.type) throw new Error('Missing date or type');
        result = setCalendarDay(data.date, data.type, data.note || '');
        break;
      }

      case 'deleteCalendarDay': {
        var authCheck = _requireAdmin(data.token);
        if (!authCheck.ok) { result = { success: false, error: authCheck.error }; break; }
        if (!data.date) throw new Error('Missing date');
        result = deleteCalendarDay(data.date);
        break;
      }

      default:
        result = { success: false, error: 'Unknown action: ' + data.action };
    }

  } catch (error) {
    result = { status: 'error', success: false, message: error.toString() };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  PASSWORD HASHING
//  SHA-256 via Utilities.computeDigest. Self-migrating: if a plaintext
//  password from before this patch is ever encountered, it upgrades to a
//  hash on that login and rewrites the sheet cell — harmless even though
//  this site has no live data yet, since it costs nothing to have.
// ============================================================
function _hashPassword(plain) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(plain), Utilities.Charset.UTF_8);
  return raw.map(function(b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function _checkPassword(sheet, rowIndex, storedValue, suppliedPlain) {
  var suppliedHash = _hashPassword(suppliedPlain);
  if (String(storedValue) === suppliedHash) return { ok: true };
  if (String(storedValue) === String(suppliedPlain)) {
    try { sheet.getRange(rowIndex, 2).setValue(suppliedHash); } catch (e) { /* non-fatal */ }
    return { ok: true };
  }
  return { ok: false };
}

// ============================================================
//  LOGIN RATE LIMITING
// ============================================================
function _loginAttemptKey(username) { return 'loginfail:' + String(username || '').toLowerCase(); }

function _checkLoginLockout(username) {
  try {
    var raw = CacheService.getScriptCache().get(_loginAttemptKey(username));
    var count = raw ? parseInt(raw) : 0;
    if (count >= LOGIN_MAX_ATTEMPTS) {
      return { ok: false, error: 'พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' };
    }
  } catch (e) { /* cache unavailable — fail open rather than lock everyone out */ }
  return { ok: true };
}

function _recordFailedLogin(username) {
  _logEvent('login_failed', 'username: ' + username);
  try {
    var cache = CacheService.getScriptCache();
    var key = _loginAttemptKey(username);
    var raw = cache.get(key);
    var count = (raw ? parseInt(raw) : 0) + 1;
    cache.put(key, String(count), LOGIN_LOCKOUT_SECONDS);
    if (count >= LOGIN_MAX_ATTEMPTS) _logEvent('login_lockout', 'username: ' + username + ' (locked after ' + count + ' failed attempts)');
  } catch (e) { /* non-fatal */ }
}

function _clearLoginAttempts(username) {
  try { CacheService.getScriptCache().remove(_loginAttemptKey(username)); } catch (e) { /* non-fatal */ }
}

// ============================================================
//  SESSION / AUTH
//  Tokens live in CacheService (no new Sheet needed). Replaces the old
//  ADMIN_SECRET (PropertiesService, single permanent shared value, no
//  expiry, no per-login revocation) with per-login tokens that auto-expire
//  after SESSION_TTL_SECONDS and can be individually revoked on logout —
//  same protective intent, meaningfully stronger mechanism.
// ============================================================
function _createSession(user) {
  var token = Utilities.getUuid();
  var session = { username: user.username, name: user.name, role: user.role || 'basic', createdAt: Date.now() };
  CacheService.getScriptCache().put('session:' + token, JSON.stringify(session), SESSION_TTL_SECONDS);
  return token;
}

function _validateSession(token) {
  if (!token) return null;
  try {
    var raw = CacheService.getScriptCache().get('session:' + token);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function _revokeSession(token) {
  if (!token) return;
  try { CacheService.getScriptCache().remove('session:' + token); } catch (e) { /* non-fatal */ }
}

// Returns {ok:true, session:{...}} or {ok:false, error:'...'}
function _requireAdmin(token) {
  var session = _validateSession(token);
  if (!session || session.role !== 'admin') {
    _logEvent('auth_rejected', 'admin-only action denied — role: ' + (session ? session.role : 'none/expired'));
    return { ok: false, error: 'ไม่ได้เข้าสู่ระบบ หรือ session หมดอายุ กรุณาเข้าสู่ระบบใหม่' };
  }
  return { ok: true, session: session };
}

// Accepts ANY valid, non-expired session regardless of role (admin OR
// recorder) — used for saveRecord/getLastRecord/getRecentRecords.
function _requireLoggedIn(token) {
  var session = _validateSession(token);
  if (!session) {
    _logEvent('auth_rejected', 'login-required action denied — no valid session');
    return { ok: false, error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };
  }
  return { ok: true, session: session };
}

// ============================================================
//  AUDIT LOG
//  Anomalies only — login failures/lockouts, rejected auth checks,
//  validation failures. Not every normal successful operation (would be
//  noisy and not useful for diagnosing problems). No rotation/archiving
//  yet — fine at current volume, revisit if this grows very large.
// ============================================================
const AUDIT_LOG_SHEET   = AUDIT_SHEET;
const AUDIT_LOG_HEADERS = ['timestamp', 'type', 'message'];

function _logEvent(type, message) {
  try {
    const sheet = getOrCreateSheet(AUDIT_LOG_SHEET, AUDIT_LOG_HEADERS);
    sheet.appendRow([new Date().toISOString(), type, message]);
  } catch (e) { /* logging must never break the actual request */ }
}

// ============================================================
//  HELPERS
// ============================================================
function getOrCreateSheet(name, headers) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground('#1a2e48').setFontColor('#00c8f0');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Reads exactly the sheet's known schema width up to its last used row,
// instead of getDataRange() (which reads whatever the sheet's full
// used-range happens to be, including any stray extra column). Benefit is
// robustness against accidental stray columns, not a guaranteed speedup.
function _readSheetRange(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  return sheet.getRange(1, 1, lastRow, headers.length).getValues();
}

// ครอบการเขียน sheet ด้วย lock กัน race condition (2 คน save พร้อมกัน)
function withLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { success: false, error: 'ระบบกำลังบันทึกข้อมูลอื่นอยู่ กรุณาลองใหม่อีกครั้ง' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  RAW-ROWS CACHE (C2b) — cache แถวดิบต่อเดือน แบบ chunked
//  แก้คอขวด: getDataRange().getValues() อ่านทั้ง sheet ทุก request (3-8s)
//  กลยุทธ์: cache แถวดิบแยกต่อเดือน → request อ่าน cache (~50ms) แทน sheet
//  correctness: cache miss/error → fallback อ่าน sheet ตรง (semantics ไม่เปลี่ยน)
// ============================================================
const CACHE_CHUNK_BYTES   = 90 * 1024;
const CACHE_CHUNK_CHARS   = Math.floor(CACHE_CHUNK_BYTES / 4); // UTF-8 worst case: 4 bytes/char
const CACHE_TTL_CURRENT   = 600;          // เดือนปัจจุบัน: 10 นาที
const CACHE_TTL_PAST      = 21600;        // เดือนเก่า: 6 ชม.
const CACHE_PREFIX        = 'raw';

function _cache() { return CacheService.getScriptCache(); }
function _monthOf(dateStr) { return String(dateStr || '').slice(0, 7); }
function _isCurrentMonth(ym) {
  return ym === Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM');
}

function _monthsInRange(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return null;
  const months = [];
  const start = new Date(dateFrom.slice(0, 7) + '-01T00:00:00');
  const end   = new Date(dateTo.slice(0, 7) + '-01T00:00:00');
  let cur = start;
  while (cur <= end) {
    months.push(Utilities.formatDate(cur, 'Asia/Bangkok', 'yyyy-MM'));
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return months;
}

function invalidateMonthCache(ym, reason) {
  if (!ym) return;
  console.log('invalidate: ' + ym + ' reason: ' + (reason || 'unknown'));
  try {
    const cache = _cache();
    const metaStr = cache.get(CACHE_PREFIX + ':' + ym + ':meta');
    const keys = [CACHE_PREFIX + ':' + ym + ':meta'];
    if (metaStr) {
      const meta = JSON.parse(metaStr);
      for (let i = 0; i < meta.chunks; i++) keys.push(CACHE_PREFIX + ':' + ym + ':' + i);
    } else {
      for (let i = 0; i < 10; i++) keys.push(CACHE_PREFIX + ':' + ym + ':' + i);
    }
    cache.removeAll(keys);
  } catch (e) { /* ignore */ }
}

// ============================================================
//  SCOPED READ ACCESS
//  Power basic-mode (recorder) entry without exposing the full consumption
//  dataset. Each is scoped to ONE meterId (or, for getMeterStatus, returns
//  booleans only). Cached — a full-sheet scan happens only on cache miss.
// ============================================================
const METER_CHAIN_CACHE_PREFIX = 'subchain:';
const METER_CHAIN_CACHE_TTL    = 300; // 5 min

// Both names now clear the same unified index (see _buildRecordsIndex).
// Kept as two functions because call sites throughout the file use both, and
// a save must invalidate the ever-recorded set and the today set together.
function invalidateMeterStatusCache() {
  invalidateRecordsIndexCache();
}
function invalidateMeterTodayCache() {
  invalidateRecordsIndexCache();
}
function invalidateMeterChainCache(meterId) {
  if (!meterId) return;
  try { _cache().remove(METER_CHAIN_CACHE_PREFIX + String(meterId)); } catch (e) { /* non-fatal */ }
}

// ============================================================
//  RECORDS INDEX — ONE sheet scan, three answers.
//
//  getMeterStatus / getMetersRecordedToday / getAvailableMonths all need the
//  same thing: a pass over the meterId + date columns of _RECORDS. They used
//  to each do their own full read, so a single admin page-load triggered four
//  scans of thousands of rows. On Apps Script the sheet read is by far the
//  slowest operation, and the added latency pushed responses past the point
//  where the /exec redirect target stays valid — which surfaced to the client
//  as intermittent 404s from script.googleusercontent.com.
//
//  Now: one scan builds all three sets and caches them together. Subsequent
//  calls in the same TTL window touch no sheet at all.
//  TTL is the shortest of the three concerns (today-status, 2 min) so the
//  red/green dot never goes stale; the other two change far more slowly and
//  are simply refreshed along with it.
// ============================================================
const RECORDS_INDEX_CACHE_KEY = 'recidx:v1';
const RECORDS_INDEX_CACHE_TTL = 120; // 2 min — bounded by the today-status need

function invalidateRecordsIndexCache() {
  try { _cache().remove(RECORDS_INDEX_CACHE_KEY); } catch (e) { /* non-fatal */ }
}

// Returns { everRecorded:[ids], recordedToday:[ids], months:[YYYY-MM], date:'YYYY-MM-DD' }
// ============================================================
//  LOGGING DAY
//
//  The recorders walk their round late at night (~23:00), so a calendar day
//  is the wrong unit for "has this meter been done yet". With a midnight
//  boundary the whole board flips red an hour after the round finishes, and
//  an admin opening the app next morning sees every meter red despite the
//  readings having just been taken.
//
//  The logging day therefore rolls over at TODAY_BOUNDARY_HOUR: readings from
//  the night of the 18th keep counting as "done" until 16:30 on the 19th,
//  after which the board resets for that night's round.
//
//  This affects the red/green indicator ONLY. The `date` written on a record
//  is whatever the person entered — the calendar date stays honest, and every
//  report, chart and demand calculation continues to use it unchanged.
// ============================================================
const TODAY_BOUNDARY_HOUR   = 16;
const TODAY_BOUNDARY_MINUTE = 30;

function _loggingDay() {
  const now = new Date();
  const hh = parseInt(Utilities.formatDate(now, 'Asia/Bangkok', 'HH'), 10);
  const mm = parseInt(Utilities.formatDate(now, 'Asia/Bangkok', 'mm'), 10);
  const beforeBoundary = (hh < TODAY_BOUNDARY_HOUR) ||
                         (hh === TODAY_BOUNDARY_HOUR && mm < TODAY_BOUNDARY_MINUTE);
  // Before the cut-off we are still inside the previous logging day.
  const ref = new Date(now.getTime() - (beforeBoundary ? 86400000 : 0));
  return Utilities.formatDate(ref, 'Asia/Bangkok', 'yyyy-MM-dd');
}

function _buildRecordsIndex() {
  try {
    const cached = _cache().get(RECORDS_INDEX_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* cache miss/error — fall through to the sheet read */ }

  const today = _loggingDay();   // logging day, not calendar day — see above
  const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
  const data = _readSheetRange(sheet, REC_HEADERS);
  const meterIdIdx = REC_HEADERS.indexOf('meterId');
  const dateIdx = REC_HEADERS.indexOf('date');

  const ever = {}, todaySet = {}, monthSet = {};
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][meterIdIdx]);
    if (id) ever[id] = true;

    const raw = data[i][dateIdx];
    const d = (raw instanceof Date)
      ? Utilities.formatDate(raw, 'Asia/Bangkok', 'yyyy-MM-dd')
      : String(raw || '').slice(0, 10);
    if (!d) continue;
    if (d.length >= 7) monthSet[d.slice(0, 7)] = true;
    if (d === today && id) todaySet[id] = true;
  }

  const index = {
    everRecorded:  Object.keys(ever),
    recordedToday: Object.keys(todaySet),
    months:        Object.keys(monthSet).sort().reverse(),
    date:          today
  };
  try { _cache().put(RECORDS_INDEX_CACHE_KEY, JSON.stringify(index), RECORDS_INDEX_CACHE_TTL); } catch (e) { /* non-fatal */ }
  return index;
}

function _resolveIds(meterIds) {
  return (Array.isArray(meterIds) && meterIds.length)
    ? meterIds.map(String)
    : getAllMeters().map(s => String(s.id));
}

// Returns both maps from one index build — the entry screen needs both and
// this is the single slowest hop in the app, so they travel together.
function getMeterStatus(meterIds) {
  const idx = _buildRecordsIndex();
  const ever = {}; idx.everRecorded.forEach(function(id){ ever[id] = true; });
  const today = {}; idx.recordedToday.forEach(function(id){ today[id] = true; });

  const ids = _resolveIds(meterIds);
  const status = {}, todayStatus = {};
  ids.forEach(function(id){
    status[id] = !!ever[id];
    todayStatus[id] = !!today[id];
  });
  return { success: true, status: status, today: todayStatus, date: idx.date };
}

function getMetersRecordedToday(meterIds) {
  const idx = _buildRecordsIndex();
  const today = {}; idx.recordedToday.forEach(function(id){ today[id] = true; });
  const ids = _resolveIds(meterIds);
  const status = {};
  ids.forEach(function(id){ status[id] = !!today[id]; });
  return { success: true, status: status, date: idx.date };
}

function getAvailableMonths() {
  const idx = _buildRecordsIndex();
  return { success: true, months: idx.months };
}

// ============================================================
//  BULK RECENT RECORDS — one scan, latest N readings for EVERY meter.
//
//  The entry screen needs the last few readings of whichever meter the
//  recorder taps. Fetching them per-meter meant one request per tap, and
//  each request re-read the entire sheet server-side before discarding all
//  but one meter's rows. Opening 66 meters therefore cost 66 requests and 66
//  full scans — the dominant source of both the slowness and the exposure to
//  intermittent 404s on the /exec redirect.
//
//  This returns the same per-meter shape (including the computed `used`
//  delta and the meter's multiplier) for all meters at once, from a single
//  pass. The client caches it and opens meters with no network call at all.
// ============================================================
const BULK_RECENT_CACHE_KEY = 'bulkrecent:v1';
const BULK_RECENT_CACHE_TTL = 120; // 2 min — same freshness bound as today-status
const BULK_RECENT_PER_METER = 5;

function invalidateBulkRecentCache() {
  try { _cache().remove(BULK_RECENT_CACHE_KEY); } catch (e) { /* non-fatal */ }
}

function getRecentRecordsAllMeters() {
  try {
    const cached = _cache().get(BULK_RECENT_CACHE_KEY);
    if (cached) return { success: true, byMeter: JSON.parse(cached), cached: true };
  } catch (e) { /* cache miss/error — fall through to the sheet read */ }

  const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
  const data = _readSheetRange(sheet, REC_HEADERS);
  const headers = data.length ? data[0] : REC_HEADERS;
  const meterIdIdx = REC_HEADERS.indexOf('meterId');

  // multiplier per meter, so `used` matches what getRecentRecordsForMeter returns
  const mult = {}, vtype = {};
  getAllMeters().forEach(function(m) {
    mult[String(m.id)] = (m.multiplier !== undefined && m.multiplier !== null && !isNaN(m.multiplier))
      ? parseFloat(m.multiplier) : 1;
    vtype[String(m.id)] = _normValueType(m.valueType);
  });

  const chains = {};
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][meterIdIdx]);
    if (!id) continue;
    const obj = {};
    headers.forEach(function(h, ci) {
      obj[h] = (data[i][ci] === '' || data[i][ci] == null) ? null : data[i][ci];
    });
    if (obj.date instanceof Date) obj.date = Utilities.formatDate(obj.date, 'Asia/Bangkok', 'yyyy-MM-dd');
    else if (obj.date) obj.date = String(obj.date).slice(0, 10);
    if (obj.time instanceof Date) obj.time = Utilities.formatDate(obj.time, 'Asia/Bangkok', 'HH:mm');
    obj.kwh = parseFloat(obj.kwh) || 0;
    if (!chains[id]) chains[id] = [];
    chains[id].push(obj);
  }

  const byMeter = {};
  Object.keys(chains).forEach(function(id) {
    const chain = chains[id];
    chain.sort(function(a, b) {
      return (a.date + ' ' + (a.time || '00:00')).localeCompare(b.date + ' ' + (b.time || '00:00'));
    });
    const m = mult[id] !== undefined ? mult[id] : 1;
    const vt = vtype[id] || 'cumulative';
    chain.forEach(function(rec, i) {
      if (vt === 'demand' || vt === 'snapshot') { rec.used = 0; }
      else if (i === chain.length - 1) { rec.used = 0; }
      else { rec.used = Math.max(0, chain[i + 1].kwh - rec.kwh) * m; }
    });
    // newest first, capped — matches getRecentRecordsForMeter's contract
    byMeter[id] = chain.slice(-BULK_RECENT_PER_METER).reverse();
  });

  try {
    const json = JSON.stringify(byMeter);
    if (json.length < 90000) _cache().put(BULK_RECENT_CACHE_KEY, json, BULK_RECENT_CACHE_TTL);
  } catch (e) { /* too large to cache — still correct, just slower next time */ }

  return { success: true, byMeter: byMeter, cached: false };
}

function _getMeterRecordChain(meterId) {
  const cacheKey = METER_CHAIN_CACHE_PREFIX + String(meterId);
  try {
    const cached = _cache().get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* cache miss/error — fall through to sheet read */ }

  const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
  const data = _readSheetRange(sheet, REC_HEADERS);
  if (data.length <= 1) return [];
  const headers = data[0];
  const meterIdIdx = REC_HEADERS.indexOf('meterId');

  const metersList = getAllMeters();
  const meterConfig = metersList.find(s => String(s.id) === String(meterId));
  const multiplier = meterConfig && meterConfig.multiplier !== undefined ? parseFloat(meterConfig.multiplier) : 1;

  const chain = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][meterIdIdx]) !== String(meterId)) continue;
    const obj = {};
    headers.forEach((h, ci) => { obj[h] = (data[i][ci] === '' || data[i][ci] == null) ? null : data[i][ci]; });
    if (obj.date instanceof Date) obj.date = Utilities.formatDate(obj.date, 'Asia/Bangkok', 'yyyy-MM-dd');
    else if (obj.date) obj.date = String(obj.date).slice(0, 10);
    if (obj.time instanceof Date) obj.time = Utilities.formatDate(obj.time, 'Asia/Bangkok', 'HH:mm');
    obj.kwh = parseFloat(obj.kwh) || 0;
    chain.push(obj);
  }
  chain.sort((a, b) => (`${a.date} ${a.time || '00:00'}`).localeCompare(`${b.date} ${b.time || '00:00'}`));
  // Only a cumulative register has a meaningful "used since last reading".
  // For a demand meter the reading IS the value; subtracting two of them
  // produces a number with no physical meaning, and would then be summed into
  // kWh totals as if it were energy.
  const vType = meterConfig ? _normValueType(meterConfig.valueType) : 'cumulative';
  chain.forEach((rec, i) => {
    if (vType === 'demand' || vType === 'snapshot') { rec.used = 0; }
    else if (i === chain.length - 1) { rec.used = 0; }
    else { const diff = chain[i + 1].kwh - rec.kwh; rec.used = Math.max(0, diff) * multiplier; }
  });

  try {
    const json = JSON.stringify(chain);
    if (json.length < 90000) _cache().put(cacheKey, json, METER_CHAIN_CACHE_TTL);
  } catch (e) { /* non-fatal */ }

  return chain;
}

function getLastRecordForMeter(meterId) {
  const chain = _getMeterRecordChain(meterId);
  if (!chain.length) return { success: true, record: null };
  return { success: true, record: chain[chain.length - 1] };
}

function getRecentRecordsForMeter(meterId, limit) {
  const n = (limit && limit > 0) ? limit : 5;
  const chain = _getMeterRecordChain(meterId);
  const recent = chain.slice(-n).reverse();
  return { success: true, records: recent };
}

// ============================================================
//  RECORDS — CRUD
// ============================================================
function getAllRecords(dateFrom, dateTo) {
  const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
  const data  = _readSheetRange(sheet, REC_HEADERS);
  if (data.length <= 1) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (row[i] === '' || row[i] == null) ? null : row[i];
    });
    if (obj.date instanceof Date) {
      obj.date = Utilities.formatDate(obj.date, 'Asia/Bangkok', 'yyyy-MM-dd');
    } else if (obj.date) {
      obj.date = String(obj.date).slice(0, 10);
    }
    if (obj.time instanceof Date) {
      obj.time = Utilities.formatDate(obj.time, 'Asia/Bangkok', 'HH:mm');
    }
    obj.kwh = parseFloat(obj.kwh) || 0;
    return obj;
  }).filter(obj => {
    if (dateFrom && obj.date < dateFrom) return false;
    if (dateTo   && obj.date > dateTo)   return false;
    return true;
  });
}

// Input validation — rejects malformed payloads before they reach the sheet.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const USER_MAX_LEN = 100;
const NOTE_MAX_LEN = 500;

function _validateRecordPayload(rec) {
  if (!rec.meterId) return 'Missing meterId';
  var kwh = rec.kwh;
  if (typeof kwh !== 'number' && typeof kwh !== 'string') return 'ค่ามิเตอร์ไม่ถูกต้อง';
  var kwhNum = parseFloat(kwh);
  if (!isFinite(kwhNum) || kwhNum < 0) return 'ค่ามิเตอร์ต้องเป็นตัวเลขและไม่ติดลบ';
  if (!rec.date || !DATE_RE.test(String(rec.date))) return 'รูปแบบวันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)';
  if (rec.time && !TIME_RE.test(String(rec.time))) return 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น HH:MM)';
  if (!rec.user || !String(rec.user).trim()) return 'กรุณาระบุผู้บันทึก';
  if (String(rec.user).length > USER_MAX_LEN) return 'ชื่อผู้บันทึกยาวเกินไป (สูงสุด ' + USER_MAX_LEN + ' ตัวอักษร)';
  if (rec.note && String(rec.note).length > NOTE_MAX_LEN) return 'หมายเหตุยาวเกินไป (สูงสุด ' + NOTE_MAX_LEN + ' ตัวอักษร)';
  return null;
}

function addRecord(rec) {
  if (!rec || !rec.meterId) return { success: false, error: 'Missing meterId' };
  const validationError = _validateRecordPayload(rec);
  if (validationError) {
    _logEvent('validation_failed', 'addRecord: ' + validationError + ' (meterId=' + rec.meterId + ')');
    return { success: false, error: validationError };
  }
  const knownMeterIds = getAllMeters().map(s => String(s.id));
  if (knownMeterIds.indexOf(String(rec.meterId)) === -1) {
    _logEvent('validation_failed', 'addRecord: unknown meterId ' + rec.meterId);
    return { success: false, error: 'ไม่พบ Meter: ' + rec.meterId + ' (meterId ไม่ถูกต้องหรือไม่มีอยู่ในระบบ)' };
  }
  return withLock(function() {
    const master = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
    if (rec.id) {
      // Only the id column is needed here. Reading the full row range pulled
      // every field of every record across the sheet just to compare one
      // string — and it happens while the person who pressed save is waiting.
      const lastRow = master.getLastRow();
      const data = lastRow > 1 ? master.getRange(2, 1, lastRow - 1, 1).getValues() : [];
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]) === String(rec.id)) {
          return { success: true, id: rec.id, duplicate: true };
        }
      }
    }
    master.appendRow(REC_HEADERS.map(h => rec[h] != null ? rec[h] : ''));
    invalidateMonthCache(_monthOf(rec.date), 'addRecord:' + rec.meterId + '@' + rec.date);
    invalidateMeterChainCache(rec.meterId);
    invalidateMeterStatusCache();
    invalidateMeterTodayCache();   // the red/green dot reads this — must reflect the save immediately
    invalidateBulkRecentCache();   // the entry screen's prev-reading comparison reads this
    return { success: true, id: rec.id };
  });
}

function editRecord(rec) {
  if (!rec || !rec.id) return { success: false, error: 'Missing id' };
  const validationError = _validateRecordPayload(rec);
  if (validationError) {
    _logEvent('validation_failed', 'editRecord: ' + validationError + ' (id=' + rec.id + ')');
    return { success: false, error: validationError };
  }
  const knownMeterIds = getAllMeters().map(s => String(s.id));
  if (knownMeterIds.indexOf(String(rec.meterId)) === -1) {
    _logEvent('validation_failed', 'editRecord: unknown meterId ' + rec.meterId + ' (id=' + rec.id + ')');
    return { success: false, error: 'ไม่พบ Meter: ' + rec.meterId + ' (meterId ไม่ถูกต้องหรือไม่มีอยู่ในระบบ)' };
  }
  return withLock(function() {
    const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
    const data  = _readSheetRange(sheet, REC_HEADERS);
    const dateIdx = REC_HEADERS.indexOf('date');
    const meterIdIdx = REC_HEADERS.indexOf('meterId');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(rec.id)) {
        const oldRaw = data[i][dateIdx];
        const oldDate = (oldRaw instanceof Date)
          ? Utilities.formatDate(oldRaw, 'Asia/Bangkok', 'yyyy-MM-dd')
          : String(oldRaw || '').slice(0, 10);
        const oldMeterId = String(data[i][meterIdIdx]);
        rec.editedTs = new Date().toISOString();
        const rowValues = REC_HEADERS.map(h => rec[h] != null ? rec[h] : '');
        sheet.getRange(i + 1, 1, 1, REC_HEADERS.length).setValues([rowValues]);
        invalidateMonthCache(_monthOf(oldDate), 'editRecord(old):' + rec.id);
        invalidateMonthCache(_monthOf(rec.date), 'editRecord(new):' + rec.id);
        invalidateMeterChainCache(oldMeterId);
        invalidateBulkRecentCache();
        if (String(rec.meterId) !== oldMeterId) invalidateMeterChainCache(rec.meterId);
        invalidateMeterStatusCache();
        invalidateBulkRecentCache();
        return { success: true };
      }
    }
    return { success: false, error: 'Record not found: ' + rec.id };
  });
}

function deleteRecord(id) {
  return withLock(function() {
    const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
    const data  = _readSheetRange(sheet, REC_HEADERS);
    const dateIdx = REC_HEADERS.indexOf('date');
    const meterIdIdx = REC_HEADERS.indexOf('meterId');
    for (let i = data.length - 1; i > 0; i--) {
      if (String(data[i][0]) === id) {
        const dRaw = data[i][dateIdx];
        const d = (dRaw instanceof Date)
          ? Utilities.formatDate(dRaw, 'Asia/Bangkok', 'yyyy-MM-dd')
          : String(dRaw || '').slice(0, 10);
        const recMeterId = String(data[i][meterIdIdx]);
        sheet.deleteRow(i + 1);
        invalidateMonthCache(_monthOf(d), 'deleteRecord:' + id);
        invalidateMeterChainCache(recMeterId);
        invalidateMeterStatusCache();
        invalidateBulkRecentCache();
        return { success: true };
      }
    }
    return { success: false, error: 'ไม่พบข้อมูลที่ต้องการลบ: ' + id };
  });
}

// ============================================================
//  MONTHLY SUMMARY
// ============================================================
function getMonthlySummary(dateFrom, dateTo, granularity) {
  const dateIdx  = REC_HEADERS.indexOf('date');
  const meterIdIdx = REC_HEADERS.indexOf('meterId');
  const kwhIdx   = REC_HEADERS.indexOf('kwh');
  const timeIdx  = REC_HEADERS.indexOf('time');

  const months = _monthsInRange(dateFrom, dateTo);
  let rows = [];
  let sheetData = null;

  if (months) {
    const cache = _cache();
    for (let mi = 0; mi < months.length; mi++) {
      const ym = months[mi];
      const cached = _readMonthFromCache(cache, ym);
      if (cached !== null) {
        rows = rows.concat(cached);
      } else {
        if (sheetData === null) sheetData = _readAllSheet();
        const mr = _filterMonthRows(sheetData, ym, dateIdx);
        _writeMonthToCache(cache, ym, mr);
        rows = rows.concat(mr);
      }
    }
  } else {
    sheetData = _readAllSheet();
    rows = sheetData.slice(1);
  }

  if (!rows.length) return { success: true, summary: [] };

  const map = {};
  for (let i = 0; i < rows.length; i++) {
    let dateRaw = rows[i][dateIdx];
    const date = (dateRaw instanceof Date)
      ? Utilities.formatDate(dateRaw, 'Asia/Bangkok', 'yyyy-MM-dd')
      : String(dateRaw || '').slice(0, 10);
    const meterId = String(rows[i][meterIdIdx] || '');
    const time  = String(rows[i][timeIdx]  || '00:00');
    const kwh   = parseFloat(rows[i][kwhIdx]) || 0;

    if (!date || !meterId) continue;
    if (dateFrom && date < dateFrom) continue;
    if (dateTo   && date > dateTo)   continue;

    const period   = periodKey(date, granularity);
    const dateTime = date + ' ' + time;
    const key      = meterId + '__' + period;

    if (!map[key]) {
      map[key] = {
        meterId, period,
        firstKwh: kwh, firstDateTime: dateTime,
        lastKwh:  kwh, lastDateTime:  dateTime,
        // Highest reading in the period and the day it occurred. Meaningless
        // for a cumulative register (the last reading is always the highest),
        // but it is the whole point for a demand meter: the billed figure is
        // the monthly peak, and knowing the date tells you when it happened.
        maxKwh: kwh, maxDate: date,
        count: 0
      };
    }
    const e = map[key];
    if (dateTime < e.firstDateTime) { e.firstDateTime = dateTime; e.firstKwh = kwh; }
    if (dateTime > e.lastDateTime)  { e.lastDateTime  = dateTime; e.lastKwh  = kwh; }
    if (kwh > e.maxKwh)             { e.maxKwh = kwh; e.maxDate = date; }
    e.count++;
  }

  const summary = Object.values(map).sort((a, b) =>
    a.period.localeCompare(b.period)
  );

  return { success: true, summary: summary };
}

function _readAllSheet() {
  const sheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
  return _readSheetRange(sheet, REC_HEADERS);
}

function _filterMonthRows(sheetData, ym, dateIdx) {
  const out = [];
  for (let i = 1; i < sheetData.length; i++) {
    const dateRaw = sheetData[i][dateIdx];
    const date = (dateRaw instanceof Date)
      ? Utilities.formatDate(dateRaw, 'Asia/Bangkok', 'yyyy-MM-dd')
      : String(dateRaw || '').slice(0, 10);
    if (date.slice(0, 7) === ym) out.push(sheetData[i]);
  }
  return out;
}

function _readMonthFromCache(cache, ym) {
  try {
    const metaStr = cache.get(CACHE_PREFIX + ':' + ym + ':meta');
    if (!metaStr) return null;
    const meta = JSON.parse(metaStr);
    const keys = [];
    for (let i = 0; i < meta.chunks; i++) keys.push(CACHE_PREFIX + ':' + ym + ':' + i);
    const got = cache.getAll(keys);
    let joined = '';
    for (let i = 0; i < meta.chunks; i++) {
      const part = got[CACHE_PREFIX + ':' + ym + ':' + i];
      if (part == null) return null;
      joined += part;
    }
    return JSON.parse(joined);
  } catch (e) { return null; }
}

function _writeMonthToCache(cache, ym, monthRows) {
  try {
    const json = JSON.stringify(monthRows);
    const ttl = _isCurrentMonth(ym) ? CACHE_TTL_CURRENT : CACHE_TTL_PAST;
    const jitter = Math.floor(Math.random() * 120) - 60;
    const toPut = {};
    let n = 0;
    for (let i = 0; i < json.length; i += CACHE_CHUNK_CHARS) {
      toPut[CACHE_PREFIX + ':' + ym + ':' + n] = json.slice(i, i + CACHE_CHUNK_CHARS);
      n++;
    }
    toPut[CACHE_PREFIX + ':' + ym + ':meta'] = JSON.stringify({ chunks: n, rows: monthRows.length });
    cache.putAll(toPut, Math.max(60, ttl + jitter));
  } catch (e) { /* เขียน cache ไม่ได้ก็ไม่เป็นไร — ผลลัพธ์ยังถูก */ }
}

function periodKey(date, granularity) {
  if (granularity === 'day') return date;
  if (granularity === 'week') {
    const d   = new Date(date);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() + 4 - day);
    const yStart = new Date(d.getFullYear(), 0, 1);
    const week   = Math.ceil((((d - yStart) / 86400000) + 1) / 7);
    return d.getFullYear() + '-W' + String(week).padStart(2, '0');
  }
  return date.slice(0, 7);
}

// ============================================================
//  METERS
// ============================================================

// Cached — _SUBS rarely changes. 12h TTL, invalidated explicitly by
// updateMeterConfig/deleteMeter.
const METERS_CACHE_KEY = 'meters:all';
const METERS_CACHE_TTL = 12 * 60 * 60;

function invalidateMetersCache() {
  try { _cache().remove(METERS_CACHE_KEY); } catch (e) { /* non-fatal */ }
}

function getAllMeters() {
  try {
    const cached = _cache().get(METERS_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* cache miss/error — fall through to sheet read */ }

  const sheet = getOrCreateSheet(METERS_SHEET, METER_HEADERS);
  const data  = _readSheetRange(sheet, METER_HEADERS);
  let result;
  if (data.length <= 1) {
    initDefaultMeters(sheet);
    result = _readSheetRange(sheet, METER_HEADERS).slice(1).map(mapMeterRow);
  } else {
    result = data.slice(1).map(mapMeterRow);
  }
  try { _cache().put(METERS_CACHE_KEY, JSON.stringify(result), METERS_CACHE_TTL); } catch (e) { /* non-fatal */ }
  return result;
}

function mapMeterRow(row) {
  return {
    id:         row[0],
    name:       row[1],
    zone:       row[2],
    unit:       row[3],
    decimal:    (row[4] !== '' && row[4] !== null && !isNaN(row[4])) ? parseInt(row[4])   : 0,
    multiplier: (row[5] !== '' && row[5] !== null && !isNaN(row[5])) ? parseFloat(row[5]) : 1,
    valueType:  _normValueType(row[6])
  };
}

function updateMeterConfig(meter) {
  if (!meter || !meter.id) return { success: false, error: 'Missing meter id' };

  const mult = parseFloat(meter.multiplier);
  if (!isFinite(mult) || mult <= 0) {
    return { success: false, error: 'ตัวคูณ (multiplier) ต้องเป็นตัวเลขมากกว่า 0' };
  }
  let dec = parseInt(meter.decimal);
  if (!isFinite(dec) || dec < 0 || dec > 4) dec = 0;

  return withLock(function() {
    const sheet = getOrCreateSheet(METERS_SHEET, METER_HEADERS);
    const data  = _readSheetRange(sheet, METER_HEADERS);
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(meter.id)) {
        sheet.getRange(i + 1, 2, 1, 6).setValues([[
          meter.name || '',
          meter.zone || '',
          meter.unit || UNIT,
          dec,
          mult,
          _normValueType(meter.valueType)
        ]]);
        // multiplier feeds directly into cached chain 'used' deltas.
        invalidateMeterChainCache(meter.id);
        invalidateMetersCache();
        return { success: true, mode: 'updated' };
      }
    }
    sheet.appendRow([
      String(meter.id),
      meter.name || '',
      meter.zone || '',
      meter.unit || UNIT,
      dec,
      mult,
      _normValueType(meter.valueType)
    ]);
    invalidateMetersCache();
    return { success: true, mode: 'added' };
  });
}

// ลบ meter ออกจาก _SUBS sheet — บล็อกถ้ายังมี record ผูกอยู่ (ป้องกัน orphaned
// records ที่ไม่มี config ให้อ้างอิง ซึ่งจะทำให้ report/chart คำนวณผิดเงียบๆ)
function deleteMeter(id) {
  if (!id) return { success: false, error: 'Missing meter id' };
  const recordSheet = getOrCreateSheet(RECORDS_SHEET, REC_HEADERS);
  const recordData = _readSheetRange(recordSheet, REC_HEADERS);
  const meterIdIdx = REC_HEADERS.indexOf('meterId');
  const hasRecords = recordData.slice(1).some(row => String(row[meterIdIdx]) === String(id));
  if (hasRecords) {
    return { success: false, error: 'ไม่สามารถลบได้ — Meter นี้มีประวัติการบันทึกอยู่แล้ว (ลบไม่ได้เพื่อป้องกันข้อมูลเก่าคำนวณผิดพลาด) แนะนำเปลี่ยนชื่อ/Zone แทนถ้าต้องการเลิกใช้งาน' };
  }
  return withLock(function() {
    const sheet = getOrCreateSheet(METERS_SHEET, METER_HEADERS);
    const data  = _readSheetRange(sheet, METER_HEADERS);
    for (let i = data.length - 1; i > 0; i--) {
      if (String(data[i][0]) === String(id)) {
        sheet.deleteRow(i + 1);
        invalidateMetersCache();
        invalidateMeterChainCache(id);
        invalidateMeterStatusCache();
        return { success: true };
      }
    }
    return { success: false, error: 'ไม่พบ Meter: ' + id };
  });
}



// ============================================================
//  REPORT GROUPS  (_REPORT_GROUPS sheet)
//  Consumption grouping/zoning lives here as DATA, editable by an admin
//  directly in the Sheet — no code change needed to add a zone, move a
//  meter between zones, or change a cross-zone subtraction. Replaces the
//  old hardcoded ZONE_GROUPS in the frontend.
//    meters : comma-separated meter IDs that COUNT toward this group
//    minus  : comma-separated meter IDs to SUBTRACT (cross-zone headers
//             whose flow is already inside this group's header meter)
//  A meter's `zone` field (on _METERS) is now display-grouping ONLY and is
//  fully decoupled from this — a monitoring-only meter can show under a zone
//  on the entry screen yet be absent from every group here (never counted).
// ============================================================
const GROUPS_CACHE_KEY = 'groups:all';
const GROUPS_CACHE_TTL  = 12 * 60 * 60;

function invalidateGroupsCache() {
  try { _cache().remove(GROUPS_CACHE_KEY); } catch (e) { /* non-fatal */ }
}

function _splitIds(cell) {
  if (cell === '' || cell == null) return [];
  return String(cell).split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s.length; });
}

function mapGroupRow(row) {
  return {
    key:    String(row[0] == null ? '' : row[0]).trim(),
    name:   String(row[1] == null ? '' : row[1]).trim(),
    icon:   String(row[2] == null ? '' : row[2]).trim(),
    color:  String(row[3] == null ? '' : row[3]).trim(),
    type:   String(row[4] == null ? '' : row[4]).trim(),
    meters: _splitIds(row[5]),
    minus:  _splitIds(row[6])
  };
}

function getReportGroups() {
  try {
    const cached = _cache().get(GROUPS_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* cache miss/error — fall through to sheet read */ }

  const sheet = getOrCreateSheet(GROUPS_SHEET, GROUP_HEADERS);
  const data  = _readSheetRange(sheet, GROUP_HEADERS);
  let result;
  if (data.length <= 1) {
    initDefaultReportGroups(sheet);
    result = _readSheetRange(sheet, GROUP_HEADERS).slice(1).map(mapGroupRow);
  } else {
    result = data.slice(1).map(mapGroupRow).filter(function(g){ return g.key; });
  }
  try { _cache().put(GROUPS_CACHE_KEY, JSON.stringify(result), GROUPS_CACHE_TTL); } catch (e) { /* non-fatal */ }
  return result;
}




// ============================================================
//  USERS
// ============================================================

// Reads the _USERS sheet directly (not via getAllUsers()) for the 1-based
// row index needed by the self-migrating password hash in _checkPassword().
function _attemptLogin(username, suppliedPassword) {
  var sheet = getOrCreateSheet(USERS_SHEET, USER_HEADERS);
  var data = _readSheetRange(sheet, USER_HEADERS);
  if (data.length <= 1) {
    // No users yet — seed the default admin AND a shared 'recorder' account
    // for the meter-reading team (same team/password as the Electric app,
    // per team decision — set to match whatever password you use there).
    var adminHash    = _hashPassword(ADMIN_SEED_PW);
    var recorderHash = _hashPassword(RECORDER_SEED_PW);
    sheet.getRange(2, 1, 2, USER_HEADERS.length).setValues([
      ['admin',    adminHash,    'ผู้ดูแลระบบ',   'admin'],
      ['recorder', recorderHash, 'ทีมจดมิเตอร์',  'recorder']
    ]);
    data = _readSheetRange(sheet, USER_HEADERS);
  } else if (!data.slice(1).some(row => String(row[0]).toLowerCase() === 'recorder')) {
    var recorderHash2 = _hashPassword(RECORDER_SEED_PW);
    sheet.appendRow(['recorder', recorderHash2, 'ทีมจดมิเตอร์', 'recorder']);
    data = _readSheetRange(sheet, USER_HEADERS);
  }
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      var check = _checkPassword(sheet, i + 1, data[i][1], suppliedPassword);
      if (check.ok) {
        return { found: true, user: { username: data[i][0], name: data[i][2], role: data[i][3] || 'basic' } };
      }
      return { found: false };
    }
  }
  return { found: false };
}

function getAllUsers() {
  const sheet = getOrCreateSheet(USERS_SHEET, USER_HEADERS);
  const data  = _readSheetRange(sheet, USER_HEADERS);
  if (data.length <= 1) {
    const defaultUsers = [
      ['admin', _hashPassword(ADMIN_SEED_PW), 'ผู้ดูแลระบบ', 'admin']
    ];
    sheet.getRange(2, 1, defaultUsers.length, USER_HEADERS.length).setValues(defaultUsers);
    return defaultUsers.map(row => ({
      username: row[0], password: String(row[1]), name: row[2], role: row[3]
    }));
  }
  return data.slice(1).map(row => ({
    username: row[0],
    password: String(row[1]),
    name:     row[2],
    role:     row[3] || 'basic'
  }));
}

// ============================================================
//  WORK CALENDAR
// ============================================================
function getWorkCalendar() {
  const sheet = getOrCreateSheet(CAL_SHEET, CAL_HEADERS);
  const data  = _readSheetRange(sheet, CAL_HEADERS);
  if (data.length <= 1) return [];
  return data.slice(1).map(row => ({
    date: formatDateCell(row[0]),
    type: String(row[1]),
    note: String(row[2] || '')
  }));
}

function formatDateCell(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  return String(v);
}

function setCalendarDay(date, type, note) {
  return withLock(function() {
    const sheet = getOrCreateSheet(CAL_SHEET, CAL_HEADERS);
    const data  = _readSheetRange(sheet, CAL_HEADERS);
    for (let i = 1; i < data.length; i++) {
      if (formatDateCell(data[i][0]) === String(date)) {
        sheet.getRange(i + 1, 2, 1, 2).setValues([[type, note]]);
        return { success: true, updated: true };
      }
    }
    sheet.appendRow([date, type, note]);
    return { success: true, added: true };
  });
}

function deleteCalendarDay(date) {
  return withLock(function() {
    const sheet = getOrCreateSheet(CAL_SHEET, CAL_HEADERS);
    const data  = _readSheetRange(sheet, CAL_HEADERS);
    for (let i = data.length - 1; i > 0; i--) {
      if (formatDateCell(data[i][0]) === String(date)) {
        sheet.deleteRow(i + 1);
        return { success: true };
      }
    }
    return { success: false, error: 'ไม่พบวันที่: ' + date };
  });
}


