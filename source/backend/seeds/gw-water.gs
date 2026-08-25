// Gateway seeds nothing.
//
// The Samrong seeds exist because those two apps were migrated from an
// existing sheet with a known meter list. Gateway has no such list yet, and
// guessing one would be worse than an empty sheet: a wrong meter that nobody
// notices still shows up on the entry screen for a recorder to fill in.
//
// Leave both empty and let an admin populate _METERS and _REPORT_GROUPS
// directly — the app creates the sheets with the right headers on first run,
// and everything downstream reads from them.
//
// When the Gateway meter list is known, replace these with real rows in the
// same shape as seeds/elec.gs.
function initDefaultMeters(sheet) {
  // intentionally empty — see above
}

function initDefaultReportGroups(sheet) {
  // Three placeholder shop groups so the entry screen has somewhere to put
  // meters before anyone has defined the real zoning. `type` must be set or
  // the group appears in neither the monthly report nor the utility rollup.
  const rows = [
    ['BODY',  'BODY SHOP',  '🏭', '#00D4FF', 'main', '', ''],
    ['PAINT', 'PAINT SHOP', '🎨', '#22C55E', 'main', '', ''],
    ['FRAME', 'FRAME SHOP', '🔩', '#f472b6', 'main', '', '']
  ];
  sheet.getRange(2, 1, rows.length, GROUP_HEADERS.length).setValues(rows);
}
