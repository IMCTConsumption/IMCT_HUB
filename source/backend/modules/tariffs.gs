const TARIFFS_SHEET = '_TARIFFS';
const TARIFF_HEADERS = ['month','supply','rateOn','rateOff','rateDemand','ft','service'];

// ============================================================
//  TARIFFS — electricity rates, per month, per supply point.
//
//  Stored in the sheet rather than the browser because the rates are shared
//  by every admin and, more importantly, because Ft changes every billing
//  period: keeping only "the current rates" client-side meant re-costing an
//  earlier month silently applied today's Ft to it. Each row is one month for
//  one supply point, so historical months keep the rates they were billed at.
//
//  A month with no row falls back to the most recent earlier month — usually
//  only Ft moves, so carrying the rest forward is the sensible default. The
//  caller is told which month was actually used so the UI can say so.
// ============================================================
const TARIFFS_CACHE_KEY = 'tariffs:v1';
const TARIFFS_CACHE_TTL = 3600; // 1 hour — rates change monthly at most

function invalidateTariffsCache() {
  try { _cache().remove(TARIFFS_CACHE_KEY); } catch (e) { /* non-fatal */ }
}

function _mapTariffRow(row) {
  const num = function(v) {
    return (v === '' || v === null || v === undefined || isNaN(v)) ? null : parseFloat(v);
  };
  return {
    month:      String(row[0] == null ? '' : row[0]).trim(),
    supply:     String(row[1] == null ? '' : row[1]).trim(),
    rateOn:     num(row[2]),
    rateOff:    num(row[3]),
    rateDemand: num(row[4]),
    ft:         num(row[5]),
    service:    num(row[6])
  };
}

function getTariffs() {
  try {
    const cached = _cache().get(TARIFFS_CACHE_KEY);
    if (cached) return { success: true, tariffs: JSON.parse(cached) };
  } catch (e) { /* cache miss — read the sheet */ }

  const sheet = getOrCreateSheet(TARIFFS_SHEET, TARIFF_HEADERS);
  const data = _readSheetRange(sheet, TARIFF_HEADERS);
  const rows = data.slice(1)
    .map(_mapTariffRow)
    .filter(function(t) { return t.month && t.supply; })
    .sort(function(a, b) { return b.month.localeCompare(a.month); });   // newest first

  try { _cache().put(TARIFFS_CACHE_KEY, JSON.stringify(rows), TARIFFS_CACHE_TTL); } catch (e) { /* non-fatal */ }
  return { success: true, tariffs: rows };
}

// Upsert one (month, supply) row.
function saveTariff(t) {
  if (!t || !t.month || !t.supply) return { success: false, error: 'ต้องระบุเดือนและจุดรับไฟ' };
  if (!/^\d{4}-\d{2}$/.test(String(t.month))) return { success: false, error: 'รูปแบบเดือนต้องเป็น YYYY-MM' };

  const num = function(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = parseFloat(v);
    if (!isFinite(n) || n < 0) return '';
    return n;
  };
  const rowValues = [
    String(t.month), String(t.supply),
    num(t.rateOn), num(t.rateOff), num(t.rateDemand), num(t.ft), num(t.service)
  ];

  return withLock(function() {
    const sheet = getOrCreateSheet(TARIFFS_SHEET, TARIFF_HEADERS);
    const data = _readSheetRange(sheet, TARIFF_HEADERS);
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(t.month) &&
          String(data[i][1]).trim() === String(t.supply)) {
        sheet.getRange(i + 1, 1, 1, TARIFF_HEADERS.length).setValues([rowValues]);
        invalidateTariffsCache();
        return { success: true, mode: 'updated' };
      }
    }
    sheet.appendRow(rowValues);
    invalidateTariffsCache();
    return { success: true, mode: 'added' };
  });
}

