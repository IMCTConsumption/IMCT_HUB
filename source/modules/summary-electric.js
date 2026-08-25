/* ════════════════════════════════════════════════════════════
   MONTHLY REPORT (SR-Electric)
   Two summary cards: (1) whole-month cross-zone grid, (2) per-meter
   drilldown per zone. Both driven by _REPORT_GROUPS from the Sheet
   (see reportGroupsMain()/reportGroupsUtil() — filtered by the `type`
   column: main groups appear as individual columns, util groups roll
   up under one UTILITY PLANT column).
   ════════════════════════════════════════════════════════════ */
let reportRaw           = [];
let reportComputed      = null;
let zoneReportRaw       = [];
let zoneReportComputed  = null;
let reportReqId         = 0;
let zoneReportReqId     = 0;

function reportGroupsMain(){ return reportGroups.filter(g => g.type === 'main'); }
function reportGroupsUtil(){ return reportGroups.filter(g => g.type === 'util'); }


function sumGroupOnDay(meterMap, col, dateStr, allDates){
  const ids   = Array.isArray(col) ? col : (col.meters || []);
  const minus = Array.isArray(col) ? []  : (col.minus  || []);
  let total = 0, hasAny = false;
  ids.forEach(id => {
    if(!_countsTowardEnergy(id)) return;
    const u = meterUsedOnDay(meterMap, id, dateStr, allDates);
    if(u !== null){ total += u; hasAny = true; }
  });
  minus.forEach(id => {
    if(!_countsTowardEnergy(id)) return;
    const u = meterUsedOnDay(meterMap, id, dateStr, allDates);
    if(u !== null){ total -= u; hasAny = true; }
  });
  return hasAny ? total : null;
}

/* ── buildMonthOptions ── */
/* Months offered in the report pickers.
   Generated from the CALENDAR, not from the loaded `records` array. The two
   are deliberately decoupled: report figures are computed server-side by
   getMonthlySummary, which can answer for any month regardless of what the
   client happens to have in memory. Deriving the list from `records` used to
   mean that narrowing the admin record window (see ADMIN_RECORD_WINDOW_DAYS)
   also silently removed older months from the dropdown — the numbers were
   always available, you just couldn't ask for them. */
function buildMonthOptions(){
  const MN = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  // Only months that actually hold data (from the server), so picking a month
  // can never land on an empty report. Falls back to whatever is in `records`
  // if the month list hasn't loaded yet.
  const months = (availableMonths && availableMonths.length)
    ? availableMonths.slice()
    : [...new Set(records.map(r => String(r.date).slice(0,7)))].filter(Boolean).sort().reverse();
  const optsHtml = months.map(m => { const [y,mm]=m.split('-'); return `<option value="${m}">${MN[parseInt(mm)]} ${y}</option>`; }).join('');
  const sel = document.getElementById('rep-month');
  if(sel){
    const prevMonth = sel.value;
    sel.innerHTML = optsHtml;
    if(prevMonth && months.includes(prevMonth)) sel.value = prevMonth;
  }
  // เดือนของ "รายละเอียดรายมิเตอร์แยกตาม Zone" เป็น dropdown แยกอิสระของตัวเอง — เลือกดูคนละเดือน
  // กับตารางรายงานหลักด้านบนได้ ใช้รายชื่อเดือนชุดเดียวกัน (สร้างจากปฏิทิน ไม่ใช่จาก records)
  // แต่ค่าที่เลือกไม่ผูกกัน แต่ละอันจดจำค่าที่เลือกไว้ของตัวเอง
  const zoneSel = document.getElementById('zone-rep-month');
  if(zoneSel){
    const prevZoneMonth = zoneSel.value;
    zoneSel.innerHTML = optsHtml;
    if(prevZoneMonth && months.includes(prevZoneMonth)) zoneSel.value = prevZoneMonth;
  }
}

/* ── loadReport ── */
async function loadReport(){
  const thisReq = ++reportReqId;
  const month = document.getElementById('rep-month')?.value;
  if(!month){ document.getElementById('report-area').innerHTML = '<div class="section-empty">ไม่มีข้อมูล</div>'; return; }
  const [y,m] = month.split('-');
  const dateFrom = `${month}-01`;
  const lastDay  = new Date(parseInt(y), parseInt(m), 0).getDate();
  // ดึงเพิ่ม 7 วันหลังสิ้นเดือน เพื่อให้วันสุดท้ายคำนวณ used ได้
  const extDate  = new Date(parseInt(y), parseInt(m)-1, lastDay+7);
  const dateTo   = `${extDate.getFullYear()}-${String(extDate.getMonth()+1).padStart(2,'0')}-${String(extDate.getDate()).padStart(2,'0')}`;
  document.getElementById('report-area').innerHTML = '<div class="section-empty">⏳ กำลังโหลด...</div>';
  try{
    const res = await getSummaryCached(dateFrom, dateTo, 'day');
    if(thisReq !== reportReqId) return; // stale request — discard
    if(!res || !res.success) throw new Error(res?.error || 'Server error');
    reportRaw = res.summary || [];
    renderReport(month, lastDay);
    renderZoneReport();
  }catch(e){
    if(thisReq !== reportReqId) return;
    document.getElementById('report-area').innerHTML = `<div class="warn-box">❌ ${e.message}</div>`;
  }
}

/* ── renderReport ── */
function renderReport(month, lastDay){
  const area = document.getElementById('report-area');
  if(!reportRaw.length){ area.innerHTML = '<div class="section-empty">📭 ไม่มีข้อมูลเดือนนี้</div>'; return; }
  const _plMap = perfLabel('buildMeterDayMap'); perfStart(_plMap);
  const meterMap = buildMeterDayMap();
  perfEnd(_plMap);
  const allDates = [...new Set(reportRaw.map(r => r.period))].sort();
  const days = [];
  for(let d = 1; d <= lastDay; d++) days.push(`${month}-${String(d).padStart(2,'0')}`);

  const _plRows = perfLabel('renderReport:rowsCompute'); perfStart(_plRows);
  const rows = days.map(dateStr => {
    const cells = {};
    reportGroupsMain().forEach(c => cells[c.key] = sumGroupOnDay(meterMap, c, dateStr, allDates));
    reportGroupsUtil().forEach(c => cells[c.key] = sumGroupOnDay(meterMap, c, dateStr, allDates));
    let utilTotal = 0, utilHas = false;
    reportGroupsUtil().forEach(c => { if(cells[c.key] !== null){ utilTotal += cells[c.key]; utilHas = true; } });
    cells['UTILITY'] = utilHas ? utilTotal : null;
    let mainTotal = 0, mainHas = false;
    reportGroupsMain().forEach(c => { if(cells[c.key] !== null){ mainTotal += cells[c.key]; mainHas = true; } });
    cells['TOTAL'] = (mainHas || utilHas) ? (mainTotal + utilTotal) : null;
    return { dateStr, cells };
  });

  const totals = {};
  [...reportGroupsMain().map(c=>c.key), ...reportGroupsUtil().map(c=>c.key), 'UTILITY','TOTAL'].forEach(k => {
    totals[k] = rows.reduce((a,r) => a + (r.cells[k]||0), 0);
  });
  perfEnd(_plRows);
  reportComputed = { month, rows, totals };

  const fmtCell = v => v === null ? '<span style="color:var(--text-3)">—</span>' : Math.round(v).toLocaleString();
  const MN = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const [yy,mm] = month.split('-');
  const headMain = reportGroupsMain().map(c => `<th style="text-align:right;padding:6px 8px;min-width:64px">${c.name}</th>`).join('');
  const headUtil = reportGroupsUtil().map(c => `<th style="text-align:right;padding:6px 8px;min-width:64px;color:var(--purple)">${c.name}</th>`).join('');

  const bodyRows = rows.map(r => {
    const dnum = parseInt(r.dateStr.split('-')[2]);
    const mainCells = reportGroupsMain().map(c => `<td style="text-align:right;padding:5px 8px">${fmtCell(r.cells[c.key])}</td>`).join('');
    const utilCells = reportGroupsUtil().map(c => `<td style="text-align:right;padding:5px 8px;color:var(--text-2)">${fmtCell(r.cells[c.key])}</td>`).join('');
    return `<tr>
      <td style="padding:5px 8px;font-weight:600;color:var(--accent);position:sticky;left:0;background:var(--surface-1)">${dnum}/${parseInt(mm)}</td>
      ${mainCells}
      <td style="text-align:right;padding:5px 8px;font-weight:700;color:var(--green);background:var(--green-dim)">${fmtCell(r.cells['UTILITY'])}</td>
      ${utilCells}
      <td style="text-align:right;padding:5px 8px;font-weight:700;color:var(--accent)">${fmtCell(r.cells['TOTAL'])}</td>
    </tr>`;
  }).join('');

  const totMain = reportGroupsMain().map(c => `<td style="text-align:right;padding:7px 8px;font-weight:700">${Math.round(totals[c.key]).toLocaleString()}</td>`).join('');
  const totUtil = reportGroupsUtil().map(c => `<td style="text-align:right;padding:7px 8px;font-weight:700;color:var(--purple)">${Math.round(totals[c.key]).toLocaleString()}</td>`).join('');

  area.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:8px;text-align:center">รายละเอียดปริมาณการใช้ไฟฟ้าแต่ละ SUBSTATION · ${MN[parseInt(mm)]} ${yy}</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:11px;white-space:nowrap">
        <thead><tr style="background:var(--surface-3)">
          <th style="padding:6px 8px;position:sticky;left:0;background:var(--surface-3);text-align:left">วันที่</th>
          ${headMain}
          <th style="text-align:right;padding:6px 8px;color:var(--green)">UTILITY<br>PLANT</th>
          ${headUtil}
          <th style="text-align:right;padding:6px 8px;color:var(--accent)">TOTAL</th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr style="background:var(--surface-3);border-top:2px solid var(--border)">
          <td style="padding:7px 8px;font-weight:700;position:sticky;left:0;background:var(--surface-3)">รวม</td>
          ${totMain}
          <td style="text-align:right;padding:7px 8px;font-weight:700;color:var(--green);background:var(--green-dim)">${Math.round(totals['UTILITY']).toLocaleString()}</td>
          ${totUtil}
          <td style="text-align:right;padding:7px 8px;font-weight:700;color:var(--accent)">${Math.round(totals['TOTAL']).toLocaleString()}</td>
        </tr></tfoot>
      </table>
    </div>
    <div style="margin-top:6px;font-size:10px;color:var(--text-3)">หน่วย: kWh · — = ไม่มีข้อมูล · UTILITY PLANT = รวม AC→Boiler · TOTAL = group หลัก + utility</div>`;
  buildCompareGroupOptions();
}

/* ── loadZoneReport ── */
async function loadZoneReport(){
  const thisReq = ++zoneReportReqId;
  const month = document.getElementById('zone-rep-month')?.value;
  const area = document.getElementById('zone-report-area');
  if(!month){ area.innerHTML = '<div class="section-empty">เลือกเดือน</div>'; zoneReportRaw = []; return; }
  const [y,m] = month.split('-');
  const dateFrom = `${month}-01`;
  const lastDay  = new Date(parseInt(y), parseInt(m), 0).getDate();
  const extDate  = new Date(parseInt(y), parseInt(m)-1, lastDay+7);
  const dateTo   = `${extDate.getFullYear()}-${String(extDate.getMonth()+1).padStart(2,'0')}-${String(extDate.getDate()).padStart(2,'0')}`;
  area.innerHTML = '<div class="section-empty">⏳ กำลังโหลด...</div>';
  try{
    const res = await getSummaryCached(dateFrom, dateTo, 'day');
    if(thisReq !== zoneReportReqId) return; // stale request — discard
    if(!res || !res.success) throw new Error(res?.error || 'Server error');
    zoneReportRaw = res.summary || [];
    renderZoneReport();
  }catch(e){
    if(thisReq !== zoneReportReqId) return;
    area.innerHTML = `<div class="warn-box">❌ ${e.message}</div>`;
  }
}

/* ── populateZoneReportSelect ── */
function populateZoneReportSelect(){
  const sel = document.getElementById('zone-rep-select');
  if(!sel) return;
  const prev = sel.value;
  // นับจำนวน sub ต่อ zone จาก subs จริง (ไม่ใช้ zone ที่ไม่มี sub อยู่เลย กันตัวเลือกว่างเปล่า)
  const counts = {};
  subs.forEach(s => { const cat = zoneName(s.zone); counts[cat] = (counts[cat]||0) + 1; });
  const cats = reportGroups.filter(g => counts[g.name] > 0).map(g => ({ name:g.name, icon:g.icon||'📦' }));
  sel.innerHTML = cats.map(c => `<option value="${c.name}">${c.icon} ${c.name} (${counts[c.name]})</option>`).join('');
  if(prev && counts[prev]) sel.value = prev;
}

/* ── renderZoneReport ── */
function renderZoneReport(){
  const area = document.getElementById('zone-report-area');
  const selectedZone = document.getElementById('zone-rep-select')?.value;
  if(!selectedZone){ area.innerHTML = '<div class="section-empty">เลือก Zone</div>'; zoneReportComputed = null; return; }
  if(!zoneReportRaw.length){ area.innerHTML = '<div class="section-empty">📭 เลือกเดือนก่อน (ยังไม่มีข้อมูลโหลดไว้)</div>'; zoneReportComputed = null; return; }
  const month = document.getElementById('zone-rep-month')?.value;
  if(!month){ area.innerHTML = '<div class="section-empty">เลือกเดือนก่อน</div>'; zoneReportComputed = null; return; }

  const zoneSubs = subs.filter(s => zoneName(s.zone) === selectedZone);
  if(!zoneSubs.length){ area.innerHTML = '<div class="section-empty">ไม่มีมิเตอร์ใน Zone นี้</div>'; zoneReportComputed = null; return; }

  const [y,m] = month.split('-');
  const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
  const meterMap = buildMeterDayMap(zoneReportRaw);
  const allDates = [...new Set(zoneReportRaw.map(r => r.period))].sort();
  const days = [];
  for(let d = 1; d <= lastDay; d++) days.push(`${month}-${String(d).padStart(2,'0')}`);

  const fmtCell = v => v === null ? '<span style="color:var(--text-3)">—</span>' : Math.round(v).toLocaleString();

  // แคชค่าต่อ (subId, dateStr) ไว้ครั้งเดียว ใช้ทั้งตอนสร้างแถวรายวันและผลรวมท้ายตาราง
  const valGrid = {};
  const spanGrid = {};   // how many days each figure covers (see meterSpanOnDay)
  zoneSubs.forEach(s => {
    valGrid[s.id] = {};
    spanGrid[s.id] = {};
    days.forEach(dateStr => {
      valGrid[s.id][dateStr]  = meterUsedOnDay(meterMap, s.id, dateStr, allDates);
      spanGrid[s.id][dateStr] = meterSpanOnDay(meterMap, s.id, dateStr, allDates);
    });
  });

  const headCols = zoneSubs.map(s =>
    `<th style="text-align:right;padding:6px 8px;min-width:70px">${s.id}<br><span style="font-weight:400;font-size:9px;color:var(--text-3)">${s.name}</span></th>`
  ).join('');

  const bodyRows = days.map(dateStr => {
    const dnum = parseInt(dateStr.split('-')[2]);
    let rowTotal = 0, rowHas = false;
    const cells = zoneSubs.map(s => {
      const v = valGrid[s.id][dateStr];
      if(v !== null){ rowTotal += v; rowHas = true; }
      const span = spanGrid[s.id][dateStr] || 1;
      if(v !== null && span > 1){
        // Flag rather than hide: this figure covers `span` days because the
        // readings in between are missing, so it is not a single day's usage.
        return `<td style="text-align:right;padding:5px 8px;background:var(--orange-dim);color:var(--orange)" title="รวม ${span} วัน (ขาดค่าที่จดระหว่างทาง)">${fmtCell(v)}<sup>*${span}</sup></td>`;
      }
      return `<td style="text-align:right;padding:5px 8px">${fmtCell(v)}</td>`;
    }).join('');
    return `<tr>
      <td style="padding:5px 8px;font-weight:600;color:var(--accent);position:sticky;left:0;background:var(--surface-1)">${dnum}</td>
      ${cells}
      <td style="text-align:right;padding:5px 8px;font-weight:700;color:var(--accent)">${rowHas ? Math.round(rowTotal).toLocaleString() : '<span style="color:var(--text-3)">—</span>'}</td>
    </tr>`;
  }).join('');

  const totalsPerMeter = zoneSubs.map(s => days.reduce((a,dateStr) => a + (valGrid[s.id][dateStr] || 0), 0));
  const grandTotal = totalsPerMeter.reduce((a,b) => a+b, 0);
  const totCells = totalsPerMeter.map(t => `<td style="text-align:right;padding:7px 8px;font-weight:700">${Math.round(t).toLocaleString()}</td>`).join('');

  zoneReportComputed = { zoneName: selectedZone, month, days, zoneSubs, valGrid, totalsPerMeter, grandTotal };

  area.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:8px;text-align:center">${selectedZone} — รายมิเตอร์ · ${month}</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:11px;white-space:nowrap">
        <thead><tr style="background:var(--surface-3)">
          <th style="padding:6px 8px;position:sticky;left:0;background:var(--surface-3);text-align:left">วันที่</th>
          ${headCols}
          <th style="text-align:right;padding:6px 8px;color:var(--accent)">รวม</th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr style="background:var(--surface-3);border-top:2px solid var(--border)">
          <td style="padding:7px 8px;font-weight:700;position:sticky;left:0;background:var(--surface-3)">รวม</td>
          ${totCells}
          <td style="text-align:right;padding:7px 8px;font-weight:700;color:var(--accent)">${Math.round(grandTotal).toLocaleString()}</td>
        </tr></tfoot>
      </table>
    </div>
    <div style="margin-top:6px;font-size:10px;color:var(--text-3)">หน่วย: kWh · — = ไม่มีข้อมูล · <span style="color:var(--orange)">ตัวเลขพื้นส้ม *N = รวม N วัน (ขาดค่าที่จดระหว่างทาง)</span> · ${zoneSubs.length} มิเตอร์ใน Zone นี้</div>`;
}

/* ── exportZoneReportExcel ── */
async function exportZoneReportExcel(){
  if(!zoneReportComputed) return toast('ยังไม่มีข้อมูล — เลือก Zone ก่อน','err');
  try{ await ensureXLSX(); }catch(e){ return toast('โหลด Excel library ไม่ได้','err'); }
  const { zoneName, month, days, zoneSubs, valGrid, totalsPerMeter, grandTotal } = zoneReportComputed;
  const aoa = [];
  const header = ['วันที่', ...zoneSubs.map(s => `${s.id} (${s.name})`), 'รวม'];
  aoa.push(header);
  days.forEach(dateStr => {
    const dnum = parseInt(dateStr.split('-')[2]);
    let rowTotal = 0;
    const line = [dnum];
    zoneSubs.forEach(s => { const v = valGrid[s.id][dateStr]; line.push(v===null?'':Math.round(v)); if(v!==null) rowTotal += v; });
    line.push(Math.round(rowTotal));
    aoa.push(line);
  });
  const totLine = ['รวม', ...totalsPerMeter.map(t => Math.round(t)), Math.round(grandTotal)];
  aoa.push(totLine);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = header.map(()=>({wch:14}));
  XLSX.utils.book_append_sheet(wb, ws, zoneName.slice(0,28));
  XLSX.writeFile(wb, `ZoneReport_${zoneName.replace(/[^\w]+/g,'_')}_${month}.xlsx`);
  toast('✅ Export รายงานแล้ว','ok');
}

/* ── exportReportExcel ── */
async function exportReportExcel(){
  if(!reportComputed) return toast('ยังไม่มีข้อมูล','err');
  try{ await ensureXLSX(); }catch(e){ return toast('โหลด Excel library ไม่ได้','err'); }
  const { month, rows, totals } = reportComputed;
  const mm = parseInt(month.split('-')[1]);
  const aoa = [];
  const header = ['วันที่', ...reportGroupsMain().map(c=>c.name), 'UTILITY PLANT', ...reportGroupsUtil().map(c=>c.name), 'TOTAL'];
  aoa.push(header);
  rows.forEach(r => {
    const dnum = parseInt(r.dateStr.split('-')[2]);
    const line = [`${dnum}/${mm}`];
    reportGroupsMain().forEach(c => line.push(r.cells[c.key]===null?'':Math.round(r.cells[c.key])));
    line.push(r.cells['UTILITY']===null?'':Math.round(r.cells['UTILITY']));
    reportGroupsUtil().forEach(c => line.push(r.cells[c.key]===null?'':Math.round(r.cells[c.key])));
    line.push(r.cells['TOTAL']===null?'':Math.round(r.cells['TOTAL']));
    aoa.push(line);
  });
  const totLine = ['รวม'];
  reportGroupsMain().forEach(c => totLine.push(Math.round(totals[c.key])));
  totLine.push(Math.round(totals['UTILITY']));
  reportGroupsUtil().forEach(c => totLine.push(Math.round(totals[c.key])));
  totLine.push(Math.round(totals['TOTAL']));
  aoa.push(totLine);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = header.map(()=>({wch:13}));
  XLSX.utils.book_append_sheet(wb, ws, month);
  XLSX.writeFile(wb, `Report_${month}.xlsx`);
  toast('✅ Export รายงานแล้ว','ok');
}

/* ── exportFullTemplateExcel ── */
async function exportFullTemplateExcel(){
  const month = document.getElementById('rep-month')?.value;
  if(!month) return toast('เลือกเดือนก่อน (ในการ์ด "รายงานการใช้ไฟฟ้ารายเดือน")','err');
  try{ await ensureExcelJS(); }catch(e){ return toast('โหลด ExcelJS ไม่ได้: '+e.message,'err'); }

  toast('⏳ กำลังสร้างไฟล์ Excel เต็มรูปแบบ...','warn');

  // ใช้ reportComputed ที่โหลดไว้แล้วถ้าตรงกับเดือนที่เลือก — ไม่เรียก loadReport() ซ้ำ
  // (loadReport() เดิมมี summaryCache กันการยิง network ซ้ำอยู่แล้ว แต่ยังเสีย CPU
  // re-render ตาราง "รายงานการใช้ไฟฟ้ารายเดือน" ทิ้งเปล่าๆ ทุกครั้งที่กด Export
  // ถ้าเดือนตรงกันอยู่แล้วไม่มีเหตุผลต้องทำซ้ำ)
  // ข้อแลกเปลี่ยนที่ควรทราบ: ถ้ามีการบันทึกค่าใหม่จาก "เครื่องอื่น" หลังจากหน้านี้
  // โหลดเสร็จ (ไม่ผ่าน invalidateSummaryCache บนเครื่องนี้) การข้าม loadReport() จะ
  // export ข้อมูลที่ยังไม่ใหม่ที่สุด — เป็นทเรดออฟความเร็ว/ความสดที่มีอยู่แล้วทั่วแอป
  // (หน้า "รายงาน" เองก็ไม่ auto-refresh ข้ามเครื่องเช่นกัน) ไม่ใช่ปัญหาใหม่จาก patch นี้
  if(!reportComputed || reportComputed.month !== month){
    await loadReport();
  }
  if(!reportComputed || reportComputed.month !== month){
    return toast('โหลดข้อมูลเดือนนี้ไม่สำเร็จ ลองกด Refresh แล้วลองใหม่','err');
  }

  const [yy, mm] = month.split('-').map(Number);
  const lastDay  = new Date(yy, mm, 0).getDate();
  const meterMap = buildMeterDayMap(reportRaw);
  const allDates = [...new Set(reportRaw.map(r => r.period))].sort();

  try{
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Substation SR Plant Logger';
    workbook.created = new Date();

    await buildDataSheetExcelJS(workbook, reportComputed);
    await buildMeterSheetsExcelJS(workbook, month, lastDay, meterMap, allDates);

    const buf  = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `7_Sub_ประจำเดือน_${TH_MONTH_FULL[mm]}_${yy}.xlsx`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast(`✅ Export สำเร็จ (${workbook.worksheets.length} ชีท)`,'ok');
  }catch(e){
    console.error(e);
    toast('❌ สร้างไฟล์ไม่สำเร็จ: ' + e.message,'err');
  }
}


