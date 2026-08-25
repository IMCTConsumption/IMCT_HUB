/* ════════════ SUMMARY: month-based, 2 tables ════════════
   Uses getMonthlySummary({granularity:'day'}) which returns per-meter
   first/last kWh per day. We compute per-meter daily usage from that.

   Zone consumption model (matches _REPORT_GROUPS):
     Zone Net(day) = Σ used(m, day) for m in group.meters
                   − Σ used(m, day) for m in group.minus
   "Other" bucket = meters not in ANY group's `meters` or `minus`.
*/
let summaryData = null;  // { month, meters: {meterId: {date: used}}, meta: {days:[]} }

function initSummaryMonth(){
  const el = document.getElementById('sum-month');
  if(!el) return;
  // Constrain the native month picker to the span that actually holds data,
  // so it can't be scrolled to a month that will render an empty report.
  if(availableMonths && availableMonths.length){
    el.max = availableMonths[0];                       // newest
    el.min = availableMonths[availableMonths.length-1]; // oldest
    if(!el.value) el.value = availableMonths[0];
  } else if(!el.value){
    const now = new Date();
    el.value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  }
}
function buildSummaryGroupOptions(){
  const sel = document.getElementById('sum-group');
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = reportGroups.map(g => `<option value="${g.key}">${esc(g.icon||'')} ${esc(g.name)}</option>`).join('')
    + '<option value="__OTHER__">📦 Other (มิเตอร์ที่ไม่อยู่ในกลุ่มใดๆ)</option>';
  if(prev) sel.value = prev;
}

// meters not in any group's `meters` or `minus`
function getOtherMeterIds(){
  const inGroup = new Set();
  reportGroups.forEach(g => {
    (g.meters||[]).forEach(id => inGroup.add(id));
    (g.minus ||[]).forEach(id => inGroup.add(id));
  });
  return subs.map(s => s.id).filter(id => !inGroup.has(id));
}

// list of "YYYY-MM-DD" strings for every day of a YYYY-MM month
function daysOfMonth(monthYYYYMM){
  const [y,m] = monthYYYYMM.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const out = [];
  for(let d=1; d<=lastDay; d++) out.push(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  return out;
}

// Given the raw summary rows, compute per-meter per-day used values.
// Used(m, day) = firstKwh(m, nextDay) − firstKwh(m, day). If no next reading
// exists, fall back to lastKwh − firstKwh of the current day (single-reading day).
// Multiplied by the meter's multiplier.
function computeDailyUsed(rawSummary){
  const meterMap = {};
  rawSummary.forEach(r => {
    if(!meterMap[r.meterId]) meterMap[r.meterId] = {};
    meterMap[r.meterId][r.period] = { firstKwh: r.firstKwh, lastKwh: r.lastKwh };
  });
  const allDatesByMeter = {};
  Object.keys(meterMap).forEach(id => {
    allDatesByMeter[id] = Object.keys(meterMap[id]).sort();
  });
  const usedMap = {};   // { meterId: { date: usedValue } }
  Object.keys(meterMap).forEach(id => {
    const m = subs.find(s => s.id === id);
    const mult = m && m.multiplier !== undefined ? parseFloat(m.multiplier) : 1;
    const dates = allDatesByMeter[id];
    usedMap[id] = {};
    dates.forEach((d, i) => {
      const cur = meterMap[id][d];
      if(i < dates.length - 1){
        const next = meterMap[id][dates[i+1]];
        usedMap[id][d] = Math.max(0, next.firstKwh - cur.firstKwh) * mult;
      } else {
        usedMap[id][d] = Math.max(0, cur.lastKwh - cur.firstKwh) * mult;
      }
    });
  });
  return usedMap;
}

async function renderSummary(){
  const t1 = document.getElementById('sum-t1-body');
  const t2 = document.getElementById('sum-t2-body');
  if(appMode !== 'admin'){
    t1.innerHTML = '<div class="section-empty">เฉพาะแอดมิน — ต้องเข้าสู่ระบบแอดมิน</div>';
    t2.innerHTML = '';
    return;
  }
  initSummaryMonth();
  buildSummaryGroupOptions();
  const monthVal = document.getElementById('sum-month').value;
  if(!monthVal){ toast('เลือกเดือนก่อน','err'); return; }
  const dateFrom = monthVal + '-01';
  // fetch extends past month-end so we can detect the "next day" firstKwh for the last day of the month
  const [y,m] = monthVal.split('-').map(Number);
  const nextMonthStart = new Date(y, m, 1);         // first day AFTER the target month
  nextMonthStart.setDate(nextMonthStart.getDate() + 7);
  const dateTo = ymdLocal(nextMonthStart);

  t1.innerHTML = '<div class="section-empty">⏳ กำลังโหลด...</div>';
  t2.innerHTML = '<div class="section-empty">⏳ กำลังโหลด...</div>';

  try{
    const res = await getSummaryCached(dateFrom, dateTo, 'day');
    if(!res || !res.success) throw new Error((res && res.error) || 'โหลดข้อมูลไม่ได้');
    summaryData = {
      month: monthVal,
      days: daysOfMonth(monthVal),
      used: computeDailyUsed(res.summary || [])
    };
    renderSummaryTable1();
    renderSummaryTable2();
  }catch(e){
    t1.innerHTML = '<div class="warn-box">❌ ' + esc(e.message) + '</div>';
    t2.innerHTML = '';
  }
}

// helper: pretty day label "1/8"
function fmtDayShort(dateStr){
  const p = dateStr.split('-');
  return parseInt(p[2]) + '/' + parseInt(p[1]);
}
// helper: cell value ("—" if no reading recorded for that meter on that day)
function cellVal(meterId, day){
  const u = summaryData && summaryData.used[meterId] && summaryData.used[meterId][day];
  return (u === undefined || u === null) ? null : u;
}
function fmtCell(v){ return v === null ? '—' : Math.round(v).toLocaleString(); }

function renderSummaryTable1(){
  const box = document.getElementById('sum-t1-body');
  if(!summaryData){ box.innerHTML = '<div class="section-empty">กด 🔄 คำนวณ ก่อน</div>'; return; }
  const groupKey = document.getElementById('sum-group').value;
  const days = summaryData.days;
  let plusIds = [], minusIds = [];
  let groupLabel = '';
  if(groupKey === '__OTHER__'){
    plusIds = getOtherMeterIds();
    groupLabel = '📦 Other';
  } else {
    const g = groupByKey(groupKey);
    if(!g){ box.innerHTML = '<div class="section-empty">ไม่พบกลุ่ม</div>'; return; }
    plusIds  = g.meters || [];
    minusIds = g.minus  || [];
    groupLabel = (g.icon||'') + ' ' + g.name;
  }
  const nameOf = id => { const m = subs.find(x => x.id === id); return m ? m.name : '(ไม่พบใน _METERS)'; };
  const isOther = groupKey === '__OTHER__';

  // build header
  let html = `<div class="tbl-wrap"><table><thead><tr>
    <th style="position:sticky;left:0;background:var(--surface-3);z-index:2;min-width:100px">Meter</th>
    <th style="position:sticky;left:100px;background:var(--surface-3);z-index:2;min-width:180px">ชื่อ</th>`;
  days.forEach(d => { html += `<th style="text-align:right">${fmtDayShort(d)}</th>`; });
  html += `<th style="text-align:right;background:var(--accent-dim);color:var(--accent)">รวม</th></tr></thead><tbody>`;

  const rowTotals = {};
  const daySums = { plus:{}, minus:{} };
  days.forEach(d => { daySums.plus[d] = 0; daySums.minus[d] = 0; });

  const renderRow = (id, isMinus) => {
    let rowTotal = 0;
    let cells = '';
    days.forEach(d => {
      const v = cellVal(id, d);
      if(v !== null){
        rowTotal += v;
        if(isMinus) daySums.minus[d] += v;
        else        daySums.plus[d]  += v;
      }
      const cellCss = isMinus ? 'color:var(--orange)' : '';
      cells += `<td style="text-align:right;font-family:var(--font-mono);font-size:11px;${cellCss}">${v===null?'—':(isMinus?'−':'')+Math.round(v).toLocaleString()}</td>`;
    });
    rowTotals[id] = { total: rowTotal, minus: isMinus };
    const nameStyle = isMinus ? 'color:var(--text-3)' : '';
    const idStyle   = isMinus ? 'color:var(--orange)' : 'color:var(--accent)';
    const idPrefix  = isMinus ? '− ' : '';
    return `<tr>
      <td style="position:sticky;left:0;background:var(--surface-1);${idStyle};font-family:var(--font-mono);font-weight:700;z-index:1">${idPrefix}${esc(id)}</td>
      <td style="position:sticky;left:100px;background:var(--surface-1);${nameStyle};z-index:1">${esc(nameOf(id))}</td>
      ${cells}
      <td style="text-align:right;background:var(--accent-dim);color:var(--accent);font-weight:700;font-family:var(--font-mono)">${(isMinus?'−':'')+Math.round(rowTotal).toLocaleString()}</td>
    </tr>`;
  };

  plusIds.forEach(id  => { html += renderRow(id, false); });
  minusIds.forEach(id => { html += renderRow(id, true);  });

  // Net row per day (only for real groups, not Other)
  if(!isOther){
    let netRow = `<tr style="background:var(--accent-dim)">
      <td style="position:sticky;left:0;background:var(--accent-dim);color:var(--accent);font-weight:700;z-index:1" colspan="2">✅ Net ${esc(groupLabel)}</td>`;
    let grandNet = 0;
    days.forEach(d => {
      const net = daySums.plus[d] - daySums.minus[d];
      grandNet += net;
      netRow += `<td style="text-align:right;color:var(--accent);font-weight:700;font-family:var(--font-mono)">${Math.round(net).toLocaleString()}</td>`;
    });
    netRow += `<td style="text-align:right;background:var(--green-dim);color:var(--green);font-weight:700;font-family:var(--font-mono)">${Math.round(grandNet).toLocaleString()}</td></tr>`;
    html += netRow;
  }

  html += `</tbody></table></div>`;
  html += `<div style="margin-top:8px;font-size:11px;color:var(--text-3)">💡 เลื่อนซ้าย-ขวาเพื่อดูทุกวัน — คอลัมน์ Meter/ชื่อ จะติดค้างไว้</div>`;
  box.innerHTML = html;
}

function renderSummaryTable2(){
  const box = document.getElementById('sum-t2-body');
  if(!summaryData){ box.innerHTML = '<div class="section-empty">กด 🔄 คำนวณ ก่อน</div>'; return; }
  const days = summaryData.days;

  // build header
  let html = `<div class="tbl-wrap"><table><thead><tr>
    <th style="position:sticky;left:0;background:var(--surface-3);z-index:2;min-width:150px">Zone</th>`;
  days.forEach(d => { html += `<th style="text-align:right">${fmtDayShort(d)}</th>`; });
  html += `<th style="text-align:right;background:var(--accent-dim);color:var(--accent)">รวมเดือน</th></tr></thead><tbody>`;

  // compute Net for each zone × each day
  const zoneNet = {};    // { key: { date: netVal } }
  const zoneRowTotal = {};
  const dayGrandTotal = {};
  days.forEach(d => { dayGrandTotal[d] = 0; });

  reportGroups.forEach(g => {
    zoneNet[g.key] = {};
    zoneRowTotal[g.key] = 0;
    days.forEach(d => {
      let plus = 0, minus = 0;
      (g.meters||[]).forEach(id => { const v = cellVal(id, d); if(v !== null) plus += v; });
      (g.minus ||[]).forEach(id => { const v = cellVal(id, d); if(v !== null) minus += v; });
      const net = plus - minus;
      zoneNet[g.key][d] = net;
      zoneRowTotal[g.key] += net;
      dayGrandTotal[d] += net;
    });
  });

  reportGroups.forEach(g => {
    let cells = '';
    days.forEach(d => {
      cells += `<td style="text-align:right;font-family:var(--font-mono);font-size:11px">${Math.round(zoneNet[g.key][d]).toLocaleString()}</td>`;
    });
    html += `<tr>
      <td style="position:sticky;left:0;background:var(--surface-1);color:${g.color||'var(--accent)'};font-weight:700;z-index:1">${g.icon||'📦'} ${esc(g.name)}</td>
      ${cells}
      <td style="text-align:right;background:var(--accent-dim);color:var(--accent);font-weight:700;font-family:var(--font-mono)">${Math.round(zoneRowTotal[g.key]).toLocaleString()}</td>
    </tr>`;
  });

  // grand-total row
  let grandRow = `<tr style="background:var(--green-dim)">
    <td style="position:sticky;left:0;background:var(--green-dim);color:var(--green);font-weight:700;z-index:1">💧 รวมทั้งโรงงาน</td>`;
  let grandGrand = 0;
  days.forEach(d => {
    grandGrand += dayGrandTotal[d];
    grandRow += `<td style="text-align:right;color:var(--green);font-weight:700;font-family:var(--font-mono)">${Math.round(dayGrandTotal[d]).toLocaleString()}</td>`;
  });
  grandRow += `<td style="text-align:right;background:var(--green);color:#001a0e;font-weight:700;font-family:var(--font-mono)">${Math.round(grandGrand).toLocaleString()}</td></tr>`;
  html += grandRow;

  html += `</tbody></table></div>`;
  html += `<div style="margin-top:8px;font-size:11px;color:var(--text-3)">💡 Net = ผลรวม meters − ผลรวม minus (ตาม _REPORT_GROUPS)</div>`;
  box.innerHTML = html;
}

async function exportSummaryT1(){
  if(!summaryData){ return toast('กด คำนวณ ก่อน','err'); }
  const groupKey = document.getElementById('sum-group').value;
  try{ await ensureXLSX(); }catch(e){ return toast('โหลด Excel library ไม่ได้','err'); }

  const days = summaryData.days;
  let plusIds = [], minusIds = [], groupLabel = '';
  if(groupKey === '__OTHER__'){
    plusIds = getOtherMeterIds();
    groupLabel = 'Other';
  } else {
    const g = groupByKey(groupKey);
    if(!g) return toast('ไม่พบกลุ่ม','err');
    plusIds  = g.meters || [];
    minusIds = g.minus  || [];
    groupLabel = g.name;
  }
  const nameOf = id => { const m = subs.find(x => x.id === id); return m ? m.name : ''; };

  const header = ['Meter', 'ชื่อ', ...days.map(fmtDayShort), 'รวม'];
  const rows = [header];
  const daySums = { plus:{}, minus:{} };
  days.forEach(d => { daySums.plus[d] = 0; daySums.minus[d] = 0; });

  const addRow = (id, isMinus) => {
    let total = 0;
    const row = [(isMinus?'− ':'') + id, nameOf(id)];
    days.forEach(d => {
      const v = cellVal(id, d);
      if(v !== null){
        total += v;
        if(isMinus) daySums.minus[d] += v; else daySums.plus[d] += v;
        row.push(isMinus ? -Math.round(v) : Math.round(v));
      } else {
        row.push('');
      }
    });
    row.push(isMinus ? -Math.round(total) : Math.round(total));
    rows.push(row);
  };
  plusIds.forEach(id  => addRow(id, false));
  minusIds.forEach(id => addRow(id, true));
  if(groupKey !== '__OTHER__'){
    const netRow = ['Net ' + groupLabel, ''];
    let grand = 0;
    days.forEach(d => { const net = daySums.plus[d] - daySums.minus[d]; grand += net; netRow.push(Math.round(net)); });
    netRow.push(Math.round(grand));
    rows.push(netRow);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:28}, ...days.map(() => ({wch:8})), {wch:12}];
  const wb = XLSX.utils.book_new();
  const safeName = String(groupLabel).replace(/[^a-zA-Z0-9ก-๛]/g,'_').slice(0,25) || 'group';
  XLSX.utils.book_append_sheet(wb, ws, safeName);
  XLSX.writeFile(wb, `SR-Water_T1_${groupLabel}_${summaryData.month}.xlsx`);
  toast('✅ Export ตาราง 1 สำเร็จ','ok');
}

async function exportSummaryT2(){
  if(!summaryData){ return toast('กด คำนวณ ก่อน','err'); }
  try{ await ensureXLSX(); }catch(e){ return toast('โหลด Excel library ไม่ได้','err'); }
  const days = summaryData.days;

  const header = ['Zone', ...days.map(fmtDayShort), 'รวมเดือน'];
  const rows = [header];
  const dayGrand = {}; days.forEach(d => { dayGrand[d] = 0; });
  let grandGrand = 0;
  reportGroups.forEach(g => {
    let rowTotal = 0;
    const row = [g.name];
    days.forEach(d => {
      let plus = 0, minus = 0;
      (g.meters||[]).forEach(id => { const v = cellVal(id, d); if(v !== null) plus += v; });
      (g.minus ||[]).forEach(id => { const v = cellVal(id, d); if(v !== null) minus += v; });
      const net = plus - minus;
      rowTotal += net;
      dayGrand[d] += net;
      row.push(Math.round(net));
    });
    row.push(Math.round(rowTotal));
    grandGrand += rowTotal;
    rows.push(row);
  });
  const grandRow = ['รวมทั้งโรงงาน'];
  days.forEach(d => { grandRow.push(Math.round(dayGrand[d])); });
  grandRow.push(Math.round(grandGrand));
  rows.push(grandRow);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:22}, ...days.map(() => ({wch:10})), {wch:14}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ZoneDaily');
  XLSX.writeFile(wb, `SR-Water_T2_${summaryData.month}.xlsx`);
  toast('✅ Export ตาราง 2 สำเร็จ','ok');
}
