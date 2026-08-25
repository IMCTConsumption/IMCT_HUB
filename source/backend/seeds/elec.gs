// SR-Electric real topology. CONFIRMED with the plant: PAINT has 7 minus meters,
// FR has 6 minus meters (these header meters' flow already includes chiller/RO/DI/etc
// downstream, which are separately monitored in their own utility groups — subtract to
// avoid double-counting when reporting main-shop consumption).
// For a GW app, replace this seed with three empty template rows:
//   Body Shop / Paint Shop / Frame  (no meters/minus/type — admin fills in).

function initDefaultMeters(sheet) {
  // SR-Electric: no seed rows. The _METERS sheet is populated by the migration
  // function from the existing ALL_RECORDS_SUBS tab. If you deploy this to a
  // fresh Sheet (not migrated), add rows manually or via updateMeterConfig.
  // Seed data was intentionally NOT copied over from SR-Water — Electric has
  // 66+ real meters with real configs that must not be overwritten.
}

function initDefaultReportGroups(sheet) {
  const rows = [
    // ── MAIN groups (shop-level; individual columns in monthly report) ──
    ['BODY',        'BODY',        '🏭', '#00D4FF', 'main', 'SUB-15,SUB-18,SUB-19,SUB-20,SUB-24,SUB-27,SUB-28,SUB-29,SUB-30', ''],
    ['PAINT',       'PAINT',       '🎨', '#22C55E', 'main', 'SUB-09,SUB-10,SUB-11,SUB-12,SUB-38', 'AC-02,CT-ED,EDCPS,CHIL-AS3,CHIL-AS4,CT-AS,CHIL-AS12'],
    ['LA',          'LA',          '🔧', '#fb923c', 'main', 'SUB-21,SUB-22', ''],
    ['UA',          'UA',          '⚙️', '#38bdf8', 'main', 'SUB-05', ''],
    ['PT78',        'PT7,8',       '🏗️', '#a78bfa', 'main', 'SUB-02,SUB-03,SUB-04', ''],
    ['FRAME',       'FRAME',       '🔩', '#f472b6', 'main', 'SUB-33,SUB-34,SUB-36,SUB-37', ''],
    ['OFFICE',      'OFFICE',      '🏢', '#818cf8', 'main', 'SUB-31', ''],
    ['FR',          'FR',          '🚧', '#fb7185', 'main', 'SUB-08', 'CT-AC,CT-ED,WWT-01,RO-01,RO-02,DI-01'],
    ['OLDCANTEEN',  'OLD CANTEEN', '🍽️', '#FACC15', 'main', 'CANT-10', ''],
    // ── UTIL groups (utility plant; grouped under UTILITY PLANT column in monthly report) ──
    ['AIRCOMP',     'AIR COMP',    '💨', '#60a5fa', 'util', 'SUB-06,SUB-07,AC-02', ''],
    ['COOLINGAC',   'COOLING A/C', '❄️', '#38bdf8', 'util', 'CT-AC', ''],
    ['EDCHILLER',   'ED CHILLER',  '🧊', '#06b6d4', 'util', 'EDCPS', ''],
    ['COOLINGED',   'COOLING ED',  '❄️', '#0ea5e9', 'util', 'CT-ED', ''],
    ['ASNEW',       'A/S Daikin New', '🌀', '#818cf8', 'util', 'CHIL-AS3,CHIL-AS4', ''],
    ['COOLINGAS',   'Cooling A/S', '❄️', '#a78bfa', 'util', 'CT-AS', ''],
    ['ASOLD',       'A/S Daikin Old', '🌀', '#c084fc', 'util', 'CHIL-AS12', ''],
    ['WWT',         'WWT',         '♻️', '#14b8a6', 'util', 'WWT-01', ''],
    ['RO',          'RO 1+2',      '💧', '#22d3ee', 'util', 'RO-01,RO-02', ''],
    ['DI',          'DI',          '💠', '#0d9488', 'util', 'DI-01', ''],
    ['BOILER',      'BOILER',      '🔥', '#f59e0b', 'util', 'BOIL-PS', '']
  ];
  sheet.getRange(2, 1, rows.length, GROUP_HEADERS.length).setValues(rows);
}