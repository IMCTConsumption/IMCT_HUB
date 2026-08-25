/* ════════════════════════════════════════════════════════════
   COST ESTIMATION (Electric only)

   Two MEA supply points, billed separately:
     69kV  → PM(156493)   serves the plant substations
     24kV  → PM(97493570) feeds Old Canteen directly
   Each has its own energy registers and its own demand registers, so each
   gets its own tariff set and its own subtotal.

   Energy = difference across the month (a totalising register).
   Demand = the monthly MAXIMUM, not a difference: the meter holds the highest
   value of the billing cycle and resets at month end, and the peak is what MEA
   charges for. Taking last-minus-first here would give ~0 on a normal month.

   This is an estimate for watching the trend before the invoice arrives. It
   deliberately omits anything the app holds no data for — power-factor penalty
   being the obvious one — so a gap against the real bill is expected.
   ════════════════════════════════════════════════════════════ */
const VAT_RATE = 0.07;   // statutory, not user-editable

const COST_SUPPLIES = [
  { key:'MEA69', label:'69kV — โรงงาน',
    onpk:'PM156-ONPK', offpk:'PM156-OFFPK', demOn:'PM156-DEM-ONPK' },
  { key:'MEA24', label:'24kV — Old Canteen',
    onpk:'PM974-ONPK', offpk:'PM974-OFFPK', demOn:'PM974-DEM-ONPK' }
];

const TARIFF_FIELDS = [
  { k:'rateOn',  label:'ค่าพลังงาน On Peak',      unit:'บาท/kWh' },
  { k:'rateOff', label:'ค่าพลังงาน Off Peak',     unit:'บาท/kWh' },
  { k:'rateDem', label:'ค่าความต้องการพลังไฟฟ้า', unit:'บาท/kW'  },
  { k:'ft',      label:'Ft',                      unit:'บาท/kWh' },
  { k:'service', label:'ค่าบริการรายเดือน',        unit:'บาท'     }
];

/* Rates live in the _TARIFFS sheet, keyed by month + supply point.
   They used to sit in localStorage, which meant each admin's browser held its
   own copy and — the real problem — only one set of rates existed, so costing
   an earlier month applied the current Ft to it. */
let tariffRows = null;      // [{month, supply, rateOn, ...}] newest month first

async function loadTariffs(){
  try{
    const res = await apiPostAuthed({ action:'getTariffs' });
    if(res && res.success && Array.isArray(res.tariffs)) tariffRows = res.tariffs;
  }catch(e){ console.warn('⚠️ โหลดอัตราค่าไฟไม่ได้:', e.message); }
  return tariffRows;
}

/* Rates in force for a month. Exact match wins; otherwise the most recent
   earlier month is carried forward (typically only Ft differs) and the month
   actually used is reported back so the UI can be explicit about it. */
function getTariffFor(supplyKey, month){
  if(!tariffRows || !tariffRows.length) return { rates:{}, from:null, exact:false };
  const exact = tariffRows.find(t => t.supply === supplyKey && t.month === month);
  if(exact) return { rates: exact, from: month, exact: true };
  const earlier = tariffRows
    .filter(t => t.supply === supplyKey && t.month < month)
    .sort((a,b) => b.month.localeCompare(a.month))[0];
  if(earlier) return { rates: earlier, from: earlier.month, exact: false };
  return { rates:{}, from:null, exact:false };
}

// Rates currently shown in the form for a supply (used by renderTariffForms).
function getTariff(supplyKey){
  const month = document.getElementById('cost-month')?.value || '';
  return getTariffFor(supplyKey, month).rates || {};
}

function renderTariffForms(){
  const box = document.getElementById('tariff-forms');
  if(!box) return;
  box.innerHTML = COST_SUPPLIES.map(sp => {
    const t = getTariff(sp.key);
    const fields = TARIFF_FIELDS.map(f => `
      <div class="f-row">
        <label class="f-label">${esc(f.label)} <span style="color:var(--rd-ink-3);font-weight:400">(${f.unit})</span></label>
        <input class="f-input" type="number" step="any" inputmode="decimal"
               id="tf-${sp.key}-${f.k}" value="${t[f.k] !== undefined ? t[f.k] : ''}" placeholder="0">
      </div>`).join('');
    return `<div style="margin-bottom:18px">
        <div style="font-family:var(--rd-font-mono);font-size:11px;color:var(--rd-ink-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">${esc(sp.label)}</div>
        <div class="f-3col">${fields}</div>
      </div>`;
  }).join('');
}

async function saveTariffs(){
  const month = document.getElementById('cost-month')?.value;
  if(!month) return toast('เลือกเดือนก่อน','err');
  setSyncStatus('busy','กำลังบันทึกอัตรา...');
  try{
    // One row per supply point, written for the month currently selected.
    for(const sp of COST_SUPPLIES){
      const t = { month: month, supply: sp.key };
      TARIFF_FIELDS.forEach(f => {
        const el = document.getElementById('tf-' + sp.key + '-' + f.k);
        t[f.k === 'rateDem' ? 'rateDemand' : f.k] = (el && el.value !== '') ? parseFloat(el.value) : '';
      });
      await apiPostAuthed({ action:'saveTariff', tariff: t });
    }
    invalidateTariffsCacheLocal();
    await loadTariffs();
    setSyncStatus('ok','บันทึกอัตราแล้ว');
    toast('💾 บันทึกอัตราของเดือน ' + month + ' แล้ว','ok');
    renderTariffForms();
    loadCostData();
  }catch(e){
    setSyncStatus('error','บันทึกอัตราไม่สำเร็จ');
  }
}

function invalidateTariffsCacheLocal(){ tariffRows = null; }

function buildCostMonthOptions(){
  const sel = document.getElementById('cost-month');
  if(!sel) return;
  const MN = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  // Months that hold readings, plus the current month and the next two: Ft and
  // the rate schedule are often published before the month is billed, so the
  // rates need somewhere to be entered ahead of any readings existing.
  const set = {};
  (availableMonths || []).forEach(m => { set[m] = true; });
  const now = new Date();
  for(let i = 0; i <= 2; i++){
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    set[d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')] = true;
  }
  const months = Object.keys(set).sort().reverse();
  const prev = sel.value;
  sel.innerHTML = months.map(m => {
    const p = m.split('-');
    return '<option value="' + m + '">' + MN[parseInt(p[1])] + ' ' + p[0] + '</option>';
  }).join('');
  if(prev && months.indexOf(prev) >= 0) sel.value = prev;
}

let costRaw = [];

async function loadCostData(){
  const box = document.getElementById('cost-body');
  if(!box) return;
  if(appMode !== 'admin'){ box.innerHTML = '<div class="section-empty">เฉพาะแอดมิน</div>'; return; }
  buildCostMonthOptions();
  const sel = document.getElementById('cost-month');
  const month = sel ? sel.value : '';
  if(!month){ box.innerHTML = '<div class="section-empty">ไม่มีเดือนให้เลือก</div>'; return; }

  const y = parseInt(month.split('-')[0]), m = parseInt(month.split('-')[1]);
  const lastDay = new Date(y, m, 0).getDate();
  // reach past month end so the last day's delta can resolve
  const ext = new Date(y, m-1, lastDay + 7);
  const dateTo = ext.getFullYear() + '-' + String(ext.getMonth()+1).padStart(2,'0') + '-' + String(ext.getDate()).padStart(2,'0');

  box.innerHTML = '<div class="section-empty">⏳ กำลังคำนวณ...</div>';
  try{
    const res = await getSummaryCached(month + '-01', dateTo, 'day');
    if(!res || !res.success) throw new Error((res && res.error) || 'โหลดข้อมูลไม่ได้');
    costRaw = res.summary || [];
    renderCost(month);
  }catch(e){
    box.innerHTML = '<div class="warn-box">❌ ' + esc(e.message) + '</div>';
  }
}

/* Energy used across the month for a totalising meter: last reading minus
   first. Returns null when the meter has no readings in the window, so the UI
   can show "—" rather than a confident zero. */
function costEnergy(meterId, month){
  const rows = costRaw.filter(r => r.meterId === meterId && String(r.period).slice(0,7) === month);
  if(!rows.length) return null;
  rows.sort((a,b) => String(a.period).localeCompare(String(b.period)));
  const meter = subs.find(s => s.id === meterId);
  const mult = (meter && meter.multiplier !== undefined) ? parseFloat(meter.multiplier) : 1;
  return Math.max(0, rows[rows.length-1].lastKwh - rows[0].firstKwh) * mult;
}

/* Monthly peak for a demand meter plus the day it happened. Reads maxKwh from
   the server summary; falls back to lastKwh for rows written before maxKwh
   existed. */
function costDemand(meterId, month){
  const rows = costRaw.filter(r => r.meterId === meterId && String(r.period).slice(0,7) === month);
  if(!rows.length) return { peak:null, date:null };
  const meter = subs.find(s => s.id === meterId);
  const mult = (meter && meter.multiplier !== undefined) ? parseFloat(meter.multiplier) : 1;
  let peak = null, date = null;
  rows.forEach(r => {
    const v = (r.maxKwh !== undefined && r.maxKwh !== null) ? r.maxKwh : r.lastKwh;
    if(v === null || v === undefined) return;
    if(peak === null || v > peak){ peak = v; date = r.maxDate || r.period; }
  });
  return { peak: peak === null ? null : peak * mult, date: date };
}

function _money(v){ return v.toLocaleString('th-TH', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function _units(v){ return Math.round(v).toLocaleString(); }

function renderCost(month){
  const box = document.getElementById('cost-body');
  if(!box) return;
  let grandPre = 0, anyRate = false, html = '';

  COST_SUPPLIES.forEach(sp => {
    const lookup = getTariffFor(sp.key, month);
    const t = lookup.rates || {};
    const on  = costEnergy(sp.onpk, month);
    const off = costEnergy(sp.offpk, month);
    const dem = costDemand(sp.demOn, month);

    const rOn  = parseFloat(t.rateOn)  || 0;
    const rOff = parseFloat(t.rateOff) || 0;
    const rDem = parseFloat(t.rateDemand !== undefined ? t.rateDemand : t.rateDem) || 0;
    const ft   = parseFloat(t.ft)      || 0;
    const svc  = parseFloat(t.service) || 0;
    if(rOn || rOff || rDem || ft || svc) anyRate = true;

    const onKwh  = on  === null ? 0 : on;
    const offKwh = off === null ? 0 : off;
    const peakKw = dem.peak === null ? 0 : dem.peak;

    const cOn  = onKwh  * rOn;
    const cOff = offKwh * rOff;
    const cDem = peakKw * rDem;
    const cFt  = (onKwh + offKwh) * ft;
    const sub  = cOn + cOff + cDem + cFt + svc;
    grandPre += sub;

    const missing = [];
    if(on  === null) missing.push('On Peak');
    if(off === null) missing.push('Off Peak');
    if(dem.peak === null) missing.push('Demand');

    html += '<div class="card">' +
      '<div class="card-title">⚡ ' + esc(sp.label) + '</div>' +
      (missing.length ? '<div class="warn-box">⚠️ ไม่มีข้อมูลเดือนนี้: ' + missing.join(' · ') + ' — ส่วนที่ขาดนับเป็น 0</div>' : '') +
      (lookup.from && !lookup.exact
        ? '<div class="warn-box">↩️ ยังไม่ได้กรอกอัตราของเดือนนี้ — ใช้อัตราของเดือน ' + lookup.from + ' แทน</div>'
        : '') +
      '<div class="tbl-wrap"><table>' +
      '<thead><tr><th>รายการ</th><th style="text-align:right">ปริมาณ</th><th style="text-align:right">อัตรา</th><th style="text-align:right">เป็นเงิน (บาท)</th></tr></thead><tbody>' +
      '<tr><td>ค่าพลังงาน On Peak</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (on===null?'—':_units(onKwh)+' kWh') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (rOn||'—') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _money(cOn) + '</td></tr>' +
      '<tr><td>ค่าพลังงาน Off Peak</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (off===null?'—':_units(offKwh)+' kWh') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (rOff||'—') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _money(cOff) + '</td></tr>' +
      '<tr><td>ค่าความต้องการพลังไฟฟ้า' + (dem.date ? '<br><small style="color:var(--rd-ink-3)">พีคเมื่อ ' + fmtDate(dem.date) + '</small>' : '') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (dem.peak===null?'—':_units(peakKw)+' kW') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (rDem||'—') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _money(cDem) + '</td></tr>' +
      '<tr><td>Ft</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _units(onKwh+offKwh) + ' kWh</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + (ft||'—') + '</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _money(cFt) + '</td></tr>' +
      '<tr><td>ค่าบริการรายเดือน</td><td style="text-align:right">—</td><td style="text-align:right">—</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _money(svc) + '</td></tr>' +
      '</tbody><tfoot><tr style="background:var(--rd-line-2)">' +
      '<td colspan="3" style="font-weight:700">รวม ' + esc(sp.label) + ' (ก่อน VAT)</td>' +
      '<td style="text-align:right;font-weight:700;font-family:var(--rd-font-mono)">' + _money(sub) + '</td>' +
      '</tr></tfoot></table></div></div>';
  });

  const vat = grandPre * VAT_RATE;
  html += '<div class="card"><div class="card-title">🧾 รวมทั้งหมด</div>' +
    '<div class="tbl-wrap"><table><tbody>' +
    '<tr><td>รวมก่อน VAT</td><td style="text-align:right;font-family:var(--rd-font-mono);font-size:15px">' + _money(grandPre) + '</td></tr>' +
    '<tr><td>VAT 7%</td><td style="text-align:right;font-family:var(--rd-font-mono)">' + _money(vat) + '</td></tr>' +
    '<tr style="background:var(--rd-success-soft)"><td style="font-weight:700;color:var(--rd-success)">รวมสุทธิ (ประมาณการ)</td><td style="text-align:right;font-weight:700;font-family:var(--rd-font-mono);font-size:17px;color:var(--rd-success)">' + _money(grandPre + vat) + '</td></tr>' +
    '</tbody></table></div>' +
    (anyRate ? '' : '<div class="warn-box" style="margin-top:10px">⚠️ ยังไม่ได้กรอกอัตราค่าไฟ — ตัวเลขเป็น 0 ทั้งหมด กรอกในการ์ด "อัตราค่าไฟ" ด้านล่างก่อน</div>') +
    '</div>';

  box.innerHTML = html;
}
