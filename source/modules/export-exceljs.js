/* ════════════════════════════════════════════════════════════
   MONTHLY REPORT — ExcelJS export helpers (Electric-specific)
   Ported from the pre-universal SR-Electric build. Uses ExcelJS
   (loaded on-demand from CDN) for styled cells that SheetJS
   community build cannot produce (font/fill/border are Pro only).
   ════════════════════════════════════════════════════════════ */
const METER_SHEET_CHUNK = 4; // meters per output sheet

function ensureExcelJS(){
  return (typeof ExcelJS !== 'undefined') ? Promise.resolve() : loadScript(CDN.exceljs);
}

function buildMeterDayMap(raw){
  const src = raw || reportRaw;
  const m = {};
  src.forEach(r => { if(!m[r.meterId]) m[r.meterId]={}; m[r.meterId][r.period]={firstKwh:r.firstKwh,lastKwh:r.lastKwh}; });
  return m;
}

async function buildDataSheetExcelJS(workbook, rc){
  const { month, rows, totals } = rc;
  const [yy, mm] = month.split('-').map(Number);
  const lastDay = rows.length;
  const ws = workbook.addWorksheet('Data', { views:[{ state:'frozen', ySplit:4 }] });

  const mainCols = reportGroupsMain(), utilCols = reportGroupsUtil(); // 9, 11 — ตรงกับไฟล์ต้นฉบับ

  // ── column map: จงใจให้ตัวอักษรคอลัมน์ตรงกับไฟล์ต้นฉบับทุกตัว (A..Z) ──
  const DATE_COL     = 1;                                 // A
  const mainStart    = 2, mainEnd = mainStart + mainCols.length - 1;   // B..J
  const utilStart    = mainEnd + 1;                       // K
  const utilEnd      = utilStart + utilCols.length - 1;   // U
  const utilMergeEnd = utilStart + 8;                     // S — merge 'UTILITY' ครอบแค่ 9 คอลัมน์แรก
  const glanceStart  = utilMergeEnd + 1;                  // T
  const V = utilEnd + 1;   // UTILITY PLANT              // V
  const W = V + 1;         // TOTAL                       // W
  const X = W + 1;         // spacer ว่างเปล่า (มีในต้นฉบับ)  // X
  const Y = X + 1;         // เลขลำดับวัน                  // Y
  const Z = Y + 1;         // ธงวันหยุด                    // Z

  const DATA_FIRST_ROW = 5;
  const dataLastRow = DATA_FIRST_ROW + lastDay - 1;
  const totalRow = dataLastRow + 1;
  const unitRow  = totalRow + 1;
  const costRow  = unitRow + 1;
  const kwhURow  = costRow + 1;
  const bURow    = kwhURow + 1;
  const noteRow  = bURow + 1;

  const widths = {1:17.5,2:18.2,3:17.5,4:17.5,5:17.5,6:17.5,7:17.5,8:17.2,9:18.2,10:17.5,
                   11:17.5,12:16.8,13:17.5,14:17.5,15:20.2,16:17.5,17:19,18:17.5,19:17.5,20:15.8,21:15,
                   22:17,23:23.2,24:12.8,25:8.5,26:41.5};
  for(const c in widths) ws.getColumn(Number(c)).width = widths[c];

  const F_TITLE    = { name:'AngsanaUPC', size:36, bold:true };
  const F_HEAD2    = { name:'AngsanaUPC', size:24 };
  const F_HEAD_SM  = { name:'AngsanaUPC', size:22 };
  const F_HEAD3    = { name:'AngsanaUPC', size:20 };
  const F_UNITROW  = { name:'AngsanaUPC', size:22 };
  const F_UNITBOLD = { name:'AngsanaUPC', size:24, bold:true };
  const F_TOTALLBL = { name:'AngsanaUPC', size:36 };
  const F_DATECOL  = { name:'AngsanaUPC', size:26 };
  const F_VALUE    = { name:'AngsanaUPC', size:36 };
  const F_WCOL     = { name:'Arial', size:18 };
  const F_ROWLBL   = { name:'AngsanaUPC', size:22 };
  const F_SUMVAL   = { name:'AngsanaUPC', size:28 };
  const F_YCOL     = { name:'Arial', size:10 };
  const F_ZCOL     = { name:'Arial', size:22 };
  const RED        = { argb:'FFFF0000' };

  const CENTER = { horizontal:'center', vertical:'middle' };
  const DBL  = { style:'double' };
  const THIN = { style:'thin' };
  const GRID     = { top:DBL,  bottom:DBL,  left:DBL,  right:DBL  };
  const WBORDER  = { top:THIN, bottom:THIN, left:DBL,  right:THIN };
  const AUXBORDER= { top:THIN, bottom:THIN, left:THIN, right:THIN };

  function setCell(r, c, value, font, border, align, numFmt){
    const cell = ws.getCell(r, c);
    cell.value = value;
    if(font)   cell.font = font;
    if(border) cell.border = border;
    if(align)  cell.alignment = align;
    if(numFmt) cell.numFmt = numFmt;
    return cell;
  }

  // ══ แถว 1 — หัวเรื่อง (merge ถึงคอลัมน์ U เท่านั้น ตรงตามต้นฉบับ ไม่ครอบ V..Z) ══
  ws.mergeCells(1, DATE_COL, 1, utilEnd);
  setCell(1, DATE_COL, `รายละเอียดปริมาณการใช้ไฟฟ้าแต่ละ SUBSTATION   ประจำเดือน ${TH_MONTH_FULL[mm]} ${yy}`, F_TITLE, { bottom:DBL }, CENTER);
  ws.getRow(1).height = 48.75;

  // ══ แถว 2-3 — หัวตารางกลุ่ม ══
  ws.mergeCells(2,DATE_COL,3,DATE_COL); setCell(2,DATE_COL,'DATE',F_HEAD2,GRID,CENTER);
  mainCols.forEach((c,i) => { const col = mainStart+i; ws.mergeCells(2,col,3,col); setCell(2,col,c.name,F_HEAD2,GRID,CENTER); });
  ws.mergeCells(2, utilStart, 2, utilMergeEnd); setCell(2, utilStart, 'UTILITY', F_HEAD_SM, GRID, CENTER);
  utilCols.forEach((c,i) => { setCell(3, utilStart+i, c.name, F_HEAD3, GRID, CENTER); });
  // T2:U2 และ V2 = "แอบดูยอดรวม" แบบสด (มองเห็นตลอดเพราะ freeze panes อยู่แถว 5) — สูตรตรงกับต้นฉบับ
  ws.mergeCells(2, glanceStart, 2, utilEnd);
  setCell(2, glanceStart, { formula:`SUM(${colLetter(utilStart)}${totalRow}:${colLetter(utilEnd)}${totalRow})` }, F_HEAD_SM, GRID, CENTER, '#,##0');
  setCell(2, V, { formula:`SUM(${colLetter(mainStart)}${totalRow}:${colLetter(utilEnd)}${totalRow})` }, F_HEAD_SM, GRID, CENTER, '#,##0');
  setCell(3, V, 'UTILITY  PLANT', F_HEAD3, GRID, CENTER);
  setCell(2, Z, 'ใส่ช่องวันหยุด H', F_ZCOL, AUXBORDER, CENTER);

  // ══ แถว 4 — หน่วย (KW-H.), ป้าย TOTAL, ช่องกรอกจำนวนหน่วยผลิต (A4) ══
  setCell(4, DATE_COL, 1, F_UNITBOLD, GRID, CENTER, '#,##0'); // A4: จำนวนหน่วยที่ผลิตได้เดือนนี้ — กรอกเอง
  for(let c = mainStart; c <= V; c++) setCell(4, c, '( KW-H. )', F_UNITROW, GRID, CENTER);
  setCell(4, W, 'TOTAL', F_TOTALLBL, WBORDER, CENTER);
  setCell(4, Z, 'วันหยุด', F_ZCOL, AUXBORDER, CENTER);

  // ══ แถวข้อมูลรายวัน ══
  rows.forEach((row,i) => {
    const r = DATA_FIRST_ROW + i;
    const d = new Date(row.dateStr+'T00:00:00');
    setCell(r, DATE_COL, `${d.getDate()} ${EN_MONTH_FULL[d.getMonth()+1]} ${String(d.getFullYear()).slice(-2)}`, F_DATECOL, GRID, CENTER);
    mainCols.forEach((c,ci) => { const v=row.cells[c.key]; setCell(r, mainStart+ci, v===null?null:Math.round(v), F_VALUE, GRID, null, '#,##0'); });
    utilCols.forEach((c,ci) => { const v=row.cells[c.key]; setCell(r, utilStart+ci, v===null?null:Math.round(v), F_VALUE, GRID, null, '#,##0'); });
    setCell(r, V, Math.round(row.cells['UTILITY']||0), F_VALUE, GRID, null, '#,##0');
    setCell(r, W, Math.round(row.cells['TOTAL']||0), F_WCOL, WBORDER, null, '#,##0');
    setCell(r, Y, i+1, F_YCOL, AUXBORDER, CENTER);
    const isHol = getDayType(row.dateStr) === 'holiday';
    setCell(r, Z, isHol ? 'H' : '', F_ZCOL, AUXBORDER, CENTER);
  });

  // ══ แถว TOTAL — SUM สูตรจริง ══
  setCell(totalRow, DATE_COL, 'TOTAL', F_ROWLBL, GRID, CENTER);
  for(let c = mainStart; c <= V; c++){
    const L = colLetter(c);
    setCell(totalRow, c, { formula:`SUM(${L}${DATA_FIRST_ROW}:${L}${dataLastRow})` }, F_SUMVAL, GRID, null, '#,##0');
  }
  setCell(totalRow, W, { formula:`SUM(${colLetter(mainStart)}${totalRow}:${colLetter(utilEnd)}${totalRow})` }, F_WCOL, WBORDER, null, '#,##0');

  // ══ แถว UNIT COST — ช่องว่างให้กรอก ฿/kWh เอง (ไม่มีอัตราค่าไฟเก็บในระบบ) ══
  setCell(unitRow, DATE_COL, 'UNIT COST', F_ROWLBL, GRID, CENTER);
  for(let c = mainStart; c <= V; c++) setCell(unitRow, c, null, { ...F_SUMVAL, color:RED }, GRID, null, '#,##0.000');
  setCell(unitRow, W, { formula:`SUM(${colLetter(mainStart)}${unitRow}:${colLetter(utilEnd)}${unitRow})` }, F_WCOL, WBORDER, null, '#,##0.000');

  // ══ แถว COST = TOTAL × UNIT COST ══
  setCell(costRow, DATE_COL, ' COST', F_ROWLBL, GRID, CENTER);
  for(let c = mainStart; c <= V; c++){
    const L = colLetter(c);
    setCell(costRow, c, { formula:`${L}${totalRow}*${L}${unitRow}` }, F_SUMVAL, GRID, null, '#,##0');
  }
  setCell(costRow, W, { formula:`SUM(${colLetter(mainStart)}${costRow}:${colLetter(utilEnd)}${costRow})` }, F_WCOL, WBORDER, null, '#,##0');

  // ══ แถว KWH/U' = TOTAL ÷ จำนวนหน่วยผลิต (A4) ══
  setCell(kwhURow, DATE_COL, "KWH/U'", F_ROWLBL, GRID, CENTER);
  for(let c = mainStart; c <= V; c++){
    const L = colLetter(c);
    setCell(kwhURow, c, { formula:`${L}${totalRow}/$A$4` }, F_SUMVAL, GRID, null, '#,##0.00');
  }
  setCell(kwhURow, W, { formula:`SUM(${colLetter(mainStart)}${kwhURow}:${colLetter(utilEnd)}${kwhURow})` }, F_WCOL, WBORDER, null, '#,##0.00');

  // ══ แถว B/U' = COST ÷ จำนวนหน่วยผลิต (A4) ══
  setCell(bURow, DATE_COL, "B/U'", F_ROWLBL, GRID, CENTER);
  for(let c = mainStart; c <= V; c++){
    const L = colLetter(c);
    setCell(bURow, c, { formula:`${L}${costRow}/$A$4` }, F_SUMVAL, GRID, null, '#,##0.00');
  }
  setCell(bURow, W, { formula:`SUM(${colLetter(mainStart)}${bURow}:${colLetter(utilEnd)}${bURow})` }, F_WCOL, WBORDER, null, '#,##0.00');

  // ══ หมายเหตุท้ายตาราง ══
  setCell(noteRow, DATE_COL, 'UNIT COST : B/KWH', F_ROWLBL, null, null);
  setCell(noteRow, 3, 'COST: B', F_ROWLBL, null, null);

  for(let r = 2; r <= noteRow; r++) ws.getRow(r).height = (r >= unitRow && r <= bURow) ? 30 : 29.25;

  return ws;
}

async function buildMeterSheetsExcelJS(workbook, month, lastDay, meterMap, allDates){
  const days = [];
  for(let d = 1; d <= lastDay; d++) days.push(`${month}-${String(d).padStart(2,'0')}`);

  const grouped = {};
  // build categories from reportGroups (universal schema — no hardcoded LOAD_CATEGORIES)
  const _categories = reportGroups.map(g => ({ name: g.name, icon: g.icon || '📦' }));
  _categories.push({ name: 'อื่นๆ', icon: '📦' });
  _categories.forEach(c => grouped[c.name] = []);
  subs.forEach(s => { const cat = zoneName(s.zone); if(!grouped[cat]) grouped[cat] = []; grouped[cat].push(s); });

  const usedNames = new Set(['Data']);
  function safeSheetName(base){
    let name = base.replace(/[\[\]\*\/\\\?:]/g,'').slice(0,31);
    let n = name, i = 2;
    while(usedNames.has(n)){ n = (name.slice(0,28)+' '+i).slice(0,31); i++; }
    usedNames.add(n);
    return n;
  }

  _categories.forEach(cat => {
    const list = grouped[cat.name];
    if(!list.length) return;
    for(let off = 0; off < list.length; off += METER_SHEET_CHUNK){
      const chunk = list.slice(off, off+METER_SHEET_CHUNK);
      const partLabel = list.length > METER_SHEET_CHUNK ? ` (${off/METER_SHEET_CHUNK+1})` : '';
      const sheetName = safeSheetName(cat.name + partLabel);
      const ws = workbook.addWorksheet(sheetName, { views:[{ state:'frozen', ySplit:3 }] });
      buildOneMeterSheet(ws, chunk, days, meterMap, allDates, month);
    }
  });
}

function buildOneMeterSheet(ws, meters, days, meterMap, allDates, month){
  const perBlock  = 4; // DATE / METER / KW-H / COST
  const totalCols = meters.length * perBlock;
  for(let c = 1; c <= totalCols; c++) ws.getColumn(c).width = 12;

  const [yy, mm] = month.split('-').map(Number);
  ws.mergeCells(1,1,1,totalCols);
  const t = ws.getCell(1,1);
  t.value = `รายละเอียดปริมาณการใช้ไฟฟ้าแต่ละ SUBSTATION   ประจำเดือน ${TH_MONTH_FULL[mm]} ${yy}`;
  t.font = { name:'Tahoma', size:14, bold:true };
  t.alignment = { horizontal:'center', vertical:'middle' };
  ws.getRow(1).height = 24;

  meters.forEach((s,i) => {
    const base = i*perBlock + 1;
    ws.mergeCells(2, base, 2, base+3);
    const c = ws.getCell(2, base);
    c.value = `${s.id} — ${s.name}`;
    c.font = { bold:true, color:{argb:'FFFFFFFF'} };
    c.alignment = { horizontal:'center' };
    c.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1F2C3F'} };
  });
  meters.forEach((s,i) => {
    const base = i*perBlock + 1;
    ['DATE','METER','KW-H','COST'].forEach((lbl,j) => {
      const c = ws.getCell(3, base+j);
      c.value = lbl;
      c.font = { bold:true, size:10 };
      c.alignment = { horizontal:'center' };
      c.border = { top:{style:'thin'}, bottom:{style:'thin'} };
    });
  });
  ws.getRow(2).height = 18; ws.getRow(3).height = 16;

  let r = 4;
  const totalsPerMeter = meters.map(() => ({ kwh:0, cost:0 }));
  days.forEach(dateStr => {
    const dnum = parseInt(dateStr.split('-')[2]);
    meters.forEach((s,i) => {
      const base = i*perBlock + 1;
      const det = meterDetailOnDay(meterMap, s.id, dateStr, allDates);
      ws.getCell(r, base).value = dnum;
      ws.getCell(r, base).alignment = { horizontal:'center' };
      ws.getCell(r, base+1).value = det ? det.meter : null;
      ws.getCell(r, base+1).numFmt = '#,##0.####';
      ws.getCell(r, base+2).value = det ? Math.round(det.kwh) : null;
      ws.getCell(r, base+2).numFmt = '#,##0';
      ws.getCell(r, base+3).value = det ? Math.round(det.cost) : null;
      ws.getCell(r, base+3).numFmt = '#,##0';
      if(det){ totalsPerMeter[i].kwh += det.kwh; totalsPerMeter[i].cost += det.cost; }
    });
    r++;
  });

  ws.getCell(r,1).value = 'TOTAL'; ws.getCell(r,1).font = { bold:true };
  meters.forEach((s,i) => {
    const base = i*perBlock + 1;
    ws.getCell(r, base+2).value = Math.round(totalsPerMeter[i].kwh); ws.getCell(r, base+2).font = { bold:true }; ws.getCell(r, base+2).numFmt = '#,##0';
    ws.getCell(r, base+3).value = Math.round(totalsPerMeter[i].cost); ws.getCell(r, base+3).font = { bold:true }; ws.getCell(r, base+3).numFmt = '#,##0';
  });
  for(let c = 1; c <= totalCols; c++) ws.getCell(r,c).border = { top:{style:'double'} };
}
