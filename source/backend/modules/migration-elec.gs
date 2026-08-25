// ============================================================
//  MIGRATION (SR-Electric)
//
//  One-time upgrade from the legacy tab/column layout to the
//  universal schema used by all four apps.
//
//  BEFORE running:
//    1. In Google Sheets: File → Make a copy (safety net; ~10 sec).
//    2. Run this function once with dryRun=true to see the plan in
//       the Apps Script log (View → Logs). No changes made.
//    3. When satisfied, run again with dryRun=false. Sheet is
//       rewritten in place — no rollback (you have the copy above).
//
//  What it does:
//    • Renames tab  ALL_RECORDS                → _RECORDS
//    • Renames tab  ALL_RECORDS_SUBS           → _METERS
//    • Renames tab  ALL_RECORDS_USERS          → _USERS
//    • Renames tab  ALL_RECORDS_CALENDAR       → _CALENDAR
//    • Renames tab  ALL_RECORDS_AUDITLOG       → _AUDITLOG   (if present)
//    • Renames header cells  subId→meterId, subName→meterName
//      in the _RECORDS sheet (row 1)
//    • Creates _REPORT_GROUPS sheet and seeds it with the SR-Electric
//      topology (only if the sheet doesn't already exist)
//
//  Row data is NEVER modified — only tab names and the header row.
// ============================================================
function migrateSrElectric(dryRun) {
  if (dryRun === undefined) dryRun = true;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = [];
  const plan = [];

  function say(msg) { log.push(msg); Logger.log(msg); }
  function act(msg) { plan.push(msg); Logger.log((dryRun ? '[DRY-RUN] ' : '[APPLY] ') + msg); }

  say('=== migrateSrElectric — mode: ' + (dryRun ? 'DRY-RUN (no changes)' : 'APPLY (writing)') + ' ===');

  // ── Tab renames ──
  const renames = [
    ['ALL_RECORDS',           '_RECORDS'],
    ['ALL_RECORDS_SUBS',      '_METERS'],
    ['ALL_RECORDS_USERS',     '_USERS'],
    ['ALL_RECORDS_CALENDAR',  '_CALENDAR'],
    ['ALL_RECORDS_AUDITLOG',  '_AUDITLOG']
  ];
  renames.forEach(function(pair) {
    const oldName = pair[0], newName = pair[1];
    const oldSheet = ss.getSheetByName(oldName);
    const newSheet = ss.getSheetByName(newName);
    if (oldSheet && !newSheet) {
      act('rename tab: ' + oldName + ' → ' + newName);
      if (!dryRun) oldSheet.setName(newName);
    } else if (!oldSheet && newSheet) {
      say('skip: ' + oldName + ' → ' + newName + ' (already renamed)');
    } else if (oldSheet && newSheet) {
      say('WARN: both ' + oldName + ' AND ' + newName + ' exist — leaving untouched (manual review needed)');
    } else {
      say('skip: neither ' + oldName + ' nor ' + newName + ' exists');
    }
  });

  // ── Header rename in _RECORDS (subId→meterId, subName→meterName) ──
  const recSheet = ss.getSheetByName('_RECORDS');
  if (recSheet && recSheet.getLastRow() >= 1 && recSheet.getLastColumn() >= 1) {
    const header = recSheet.getRange(1, 1, 1, recSheet.getLastColumn()).getValues()[0];
    let changed = false;
    for (let i = 0; i < header.length; i++) {
      if (header[i] === 'subId')   { header[i] = 'meterId';   changed = true; }
      if (header[i] === 'subName') { header[i] = 'meterName'; changed = true; }
    }
    if (changed) {
      act('rewrite _RECORDS header row: subId→meterId, subName→meterName');
      if (!dryRun) recSheet.getRange(1, 1, 1, header.length).setValues([header]);
    } else {
      say('skip: _RECORDS header already renamed or column names unexpected');
    }
  } else {
    say('skip header rewrite: _RECORDS not found or empty');
  }

  // ── Ensure _REPORT_GROUPS sheet exists and is seeded ──
  let groupsSheet = ss.getSheetByName(GROUPS_SHEET);
  if (!groupsSheet) {
    act('create _REPORT_GROUPS sheet + seed 20 rows (9 main + 11 util)');
    if (!dryRun) {
      groupsSheet = ss.insertSheet(GROUPS_SHEET);
      groupsSheet.getRange(1, 1, 1, GROUP_HEADERS.length).setValues([GROUP_HEADERS]);
      initDefaultReportGroups(groupsSheet);
    }
  } else {
    say('skip: _REPORT_GROUPS already exists (not overwriting to avoid clobbering edits)');
  }

  // ── Invalidate all backend caches so the next request re-reads Sheet layout ──
  if (!dryRun) {
    try { invalidateMetersCache(); } catch(e) {}
    try { invalidateGroupsCache(); } catch(e) {}
    try { _cache().removeAll(['auth:*']); } catch(e) {}
    say('all backend caches invalidated');
  }

  say('=== plan (' + plan.length + ' operations) ===');
  plan.forEach(function(p, i) { say('  ' + (i+1) + '. ' + p); });
  say('=== done. mode: ' + (dryRun ? 'DRY-RUN — no changes made' : 'APPLIED') + ' ===');
  return { dryRun: dryRun, operations: plan.length, log: log };
}

// Convenience wrappers so you can pick from the Apps Script "Run" menu.
function migrateSrElectric_DryRun() { return migrateSrElectric(true);  }
function migrateSrElectric_Apply()  { return migrateSrElectric(false); }
