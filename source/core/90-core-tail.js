/* ════════════════════════════════════════════════════════════
   APEXCHARTS SYSTEM
   ════════════════════════════════════════════════════════════ */
let subChartInst = null;
let g9ChartInst = null;
let cmpChartInst = null;

function getThemeColors(){
  const s = getComputedStyle(document.documentElement);
  const g = k => (s.getPropertyValue(k)||'').trim();
  return {
    accent:g('--accent')||'#00D4FF', green:g('--green')||'#22C55E',
    orange:g('--orange')||'#fb923c', red:g('--red')||'#EF4444',
    purple:g('--purple')||'#a78bfa', yellow:g('--yellow')||'#FACC15',
    text1:g('--text-1')||'#e8f0ff', text2:g('--text-2')||'#8fa8c8', text3:g('--text-3')||'#566d8a',
    surface1:g('--surface-1')||'#111827', surface2:g('--surface-2')||'#182233',
    border:g('--border')||'#1e2c42',
    isDark: document.documentElement.getAttribute('data-theme') === 'dark'
  };
}

function getQuickRange(key){
  var today = ymdLocal();
  var t = new Date(today+'T00:00:00');
  var fmt = function(dt){ return ymdLocal(dt); };
  if(key==='7d'){ var f=new Date(t);f.setDate(f.getDate()-6); return [fmt(f),today]; }
  if(key==='30d'){ var f=new Date(t);f.setDate(f.getDate()-29); return [fmt(f),today]; }
  if(key==='thisM') return [today.slice(0,8)+'01',today];
  if(key==='lastM'){ var f=new Date(t.getFullYear(),t.getMonth()-1,1); var l=new Date(t.getFullYear(),t.getMonth(),0); return [fmt(f),fmt(l)]; }
  if(key==='3m'){ var f=new Date(t);f.setMonth(f.getMonth()-2);f.setDate(1); return [fmt(f),today]; }
  return ['',''];
}

function aggregateRecords(recs, period, dateFrom, dateTo){
  var MN = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var fmt = function(dt){ return ymdLocal(dt); };
  if(period === 'day'){
    var byDate = {};
    recs.forEach(function(r){
      if(!byDate[r.date]) byDate[r.date] = { used:0, count:0 };
      byDate[r.date].used += parseFloat(r.used)||0;
      byDate[r.date].count++;
    });
    var dates = Object.keys(byDate).sort();
    var start = dateFrom || (dates.length ? dates[0] : null);
    var end = dateTo || (dates.length ? dates[dates.length-1] : null);
    if(!start || !end) return [];
    var result = [];
    var cur = new Date(start+'T00:00:00');
    var endD = new Date(end+'T00:00:00');
    while(cur <= endD){
      var ds = fmt(cur);
      var p = ds.split('-').map(Number);
      var val = byDate[ds] ? byDate[ds].used : 0;
      result.push({ label:p[2]+'/'+p[1], value:val, date:ds, hol:getDayType(ds)==='holiday' });
      cur.setDate(cur.getDate()+1);
    }
    return result;
  }
  if(period === 'month'){
    var byM = {};
    recs.forEach(function(r){
      var key = String(r.date).slice(0,7);
      if(!byM[key]) byM[key] = 0;
      byM[key] += parseFloat(r.used)||0;
    });
    var months = Object.keys(byM).sort();
    var startM = dateFrom ? dateFrom.slice(0,7) : (months.length ? months[0] : null);
    var endM = dateTo ? dateTo.slice(0,7) : (months.length ? months[months.length-1] : null);
    if(!startM || !endM) return [];
    var result = [];
    var sp = startM.split('-').map(Number);
    var curD = new Date(sp[0], sp[1]-1, 1);
    var ep = endM.split('-').map(Number);
    var endD = new Date(ep[0], ep[1]-1, 1);
    while(curD <= endD){
      var key = curD.getFullYear()+'-'+String(curD.getMonth()+1).padStart(2,'0');
      result.push({ label:MN[curD.getMonth()+1]+' '+curD.getFullYear(), value:byM[key]||0, date:key });
      curD.setMonth(curD.getMonth()+1);
    }
    return result;
  }
  var byY = {};
  recs.forEach(function(r){
    var y = String(r.date).slice(0,4);
    if(!byY[y]) byY[y] = 0;
    byY[y] += parseFloat(r.used)||0;
  });
  return Object.entries(byY).sort(function(a,b){return a[0]-b[0];}).map(function(e){
    return { label:e[0], value:e[1], date:e[0] };
  });
}

var subChartState = { period:'day', type:'bar', showAvg:true, showHol:true };
function setSubQuick(key){
  var r = getQuickRange(key);
  document.getElementById('sub-from').value = r[0];
  document.getElementById('sub-to').value = r[1];
  renderSubChart();
}
function setSubPeriod(p){
  subChartState.period = p;
  ['day','month','year'].forEach(function(k){
    var el = document.getElementById('sub-p-'+k);
    if(el) el.className = k===p ? 'ctrl-btn green' : 'ctrl-btn';
  });
  var holBtn = document.getElementById('sub-hol');
  if(holBtn) holBtn.style.display = p==='day' ? '' : 'none';
  renderSubChart();
}
function setSubType(t){
  subChartState.type = t;
  ['bar','line'].forEach(function(k){
    var el = document.getElementById('sub-t-'+k);
    if(el) el.className = k===t ? 'ctrl-btn green' : 'ctrl-btn';
  });
  renderSubChart();
}
function toggleSubOpt(opt){
  if(opt==='avg') subChartState.showAvg = !subChartState.showAvg;
  if(opt==='hol') subChartState.showHol = !subChartState.showHol;
  var el = document.getElementById('sub-'+opt);
  var on = opt==='avg' ? subChartState.showAvg : subChartState.showHol;
  if(el) el.className = on ? 'ctrl-btn on' : 'ctrl-btn';
  renderSubChart();
}
function renderSubChart(){
  var meterId = document.getElementById('chart-sub').value;
  var el = document.getElementById('sub-chart-el');
  var sumEl = document.getElementById('sub-chart-summary');
  if(!meterId){ el.innerHTML='<div class="section-empty">เลือก Meter เพื่อดูกราฟ</div>'; sumEl.innerHTML=''; return; }
  var fromVal = document.getElementById('sub-from').value || '';
  var toVal = document.getElementById('sub-to').value || '';
  var recs = getSubRecs(meterId);
  if(fromVal) recs = recs.filter(function(r){return r.date >= fromVal;});
  if(toVal) recs = recs.filter(function(r){return r.date <= toVal;});
  if(!recs.length){ el.innerHTML='<div class="section-empty">ไม่มีข้อมูลในช่วงที่เลือก</div>'; sumEl.innerHTML=''; return; }
  var data = aggregateRecords(recs, subChartState.period, fromVal, toVal);
  if(!data.length){ el.innerHTML='<div class="section-empty">ไม่มีข้อมูล</div>'; sumEl.innerHTML=''; return; }
  var TC = getThemeColors();
  var total = data.reduce(function(a,d){return a+d.value;},0);
  var avg = data.length ? total/data.length : 0;
  var pl = subChartState.period==='day'?'วัน':subChartState.period==='month'?'เดือน':'ปี';
  var avgWork = null, avgHol = null, nWork = 0, nHol = 0;
  if(subChartState.period === 'day'){
    var sumWork = 0, sumHol = 0;
    data.forEach(function(d){
      if(d.hol){ sumHol += d.value; nHol++; }
      else { sumWork += d.value; nWork++; }
    });
    avgWork = nWork ? sumWork/nWork : 0;
    avgHol  = nHol  ? sumHol/nHol  : 0;
  }
  var labels = data.map(function(d){return d.label;});
  var chartType = subChartState.type==='bar' ? 'bar' : 'line';
  var useHolSplit = subChartState.period==='day' && subChartState.showHol && chartType==='bar';
  var series, chartColors, strokeW, strokeDash;
  if(useHolSplit){
    var workData = data.map(function(d){ return d.hol ? null : Math.round(d.value); });
    var holData  = data.map(function(d){ return d.hol ? Math.round(d.value) : null; });
    series = [
      { name:''+UNIT_WORD+' (วันทำงาน)', data:workData, type:'bar' },
      { name:''+UNIT_WORD+' (วันหยุด)',  data:holData,  type:'bar' }
    ];
    chartColors = [TC.green, TC.orange];
    strokeW = [0,0]; strokeDash = [0,0];
    if(subChartState.showAvg){
      var avgRoundS = Math.round(avgWork);
      series.push({ name:'ค่าเฉลี่ย', data:data.map(function(){return avgRoundS;}), type:'line' });
      chartColors.push(TC.accent+'77'); strokeW.push(2); strokeDash.push(5);
    }
  } else {
    var values = data.map(function(d){return Math.round(d.value);});
    series = [{ name:UNIT_WORD+' ('+UNIT+'/'+pl+')', data:values, type:chartType }];
    chartColors = [TC.green];
    strokeW = chartType==='bar' ? [0] : [2.5]; strokeDash = [0];
    if(subChartState.showAvg){
      var avgRound = Math.round(subChartState.period==='day' ? avgWork : avg);
      series.push({ name:'ค่าเฉลี่ย', data:data.map(function(){return avgRound;}), type:'line' });
      chartColors.push(TC.accent+'77');
      strokeW = chartType==='bar' ? [0,2] : [2.5,2]; strokeDash = [0,5];
    }
  }
  var opts = {
    chart:{ type:'bar', height:340, fontFamily:'IBM Plex Mono,monospace', foreColor:TC.text2,
      stacked: useHolSplit,
      toolbar:{ show:true, tools:{download:true,zoom:true,zoomin:true,zoomout:true,pan:true,reset:true} },
      background:'transparent', animations:{enabled:true,speed:400} },
    series: series,
    xaxis:{ categories:labels, axisBorder:{color:TC.border}, axisTicks:{show:false}, labels:{rotate:0, rotateAlways:false, hideOverlappingLabels:true, trim:false, style:{fontSize:'10px',colors:TC.text3}} },
    yaxis:{ labels:{style:{fontSize:'11px',colors:TC.text2}, formatter:function(v){return Math.round(v).toLocaleString();}}, axisBorder:{show:false} },
    grid:{ borderColor:TC.border, strokeDashArray:3, xaxis:{lines:{show:false}}, yaxis:{lines:{show:true}} },
    tooltip:{ theme:TC.isDark?'dark':'light', style:{fontSize:'12px'}, y:{formatter:function(v){return v!=null?Math.round(v).toLocaleString()+' '+UNIT:'—';}} },
    colors: chartColors,
    responsive:[{ breakpoint:640, options:{ chart:{height:300}, xaxis:{labels:{rotate:-45, rotateAlways:true, hideOverlappingLabels:true, style:{fontSize:'8px'}}}, plotOptions:{bar:{columnWidth:'80%'}} } }],
    plotOptions:{ bar:{borderRadius:4,columnWidth:'70%'} },
    stroke:{ width:strokeW, dashArray:strokeDash },
    fill:{ opacity:chartType==='bar'?0.7:0.8 },
    legend:{ show:series.length>1, fontSize:'11px', labels:{colors:TC.text2}, markers:{shape:'square',size:6} },
    dataLabels:{ enabled:false },
    states:{ hover:{filter:{type:'lighten',value:0.08}} }
  };
  ensureApex().then(function(){
    safeDestroyChart(subChartInst);
    el.innerHTML = '';
    subChartInst = new ApexCharts(el, opts);
    subChartInst.render();
  }).catch(function(e){ el.innerHTML = '<div class="warn-box">❌ โหลดกราฟไม่ได้: '+(e&&e.message||'')+'</div>'; });
  var avgChips;
  if(subChartState.period === 'day' && (nWork || nHol)){
    avgChips = '<span class="chip chip-green">เฉลี่ยวันทำงาน '+Math.round(avgWork).toLocaleString()+' '+UNIT+' ('+nWork+' วัน)</span> '+
               '<span class="chip" style="background:rgba(251,146,60,.15);color:var(--orange);border:1px solid rgba(251,146,60,.4)">เฉลี่ยวันหยุด '+Math.round(avgHol).toLocaleString()+' '+UNIT+' ('+nHol+' วัน)</span>';
  } else {
    avgChips = '<span class="chip chip-green">เฉลี่ย '+Math.round(avg).toLocaleString()+' '+UNIT+'/'+pl+'</span>';
  }
  sumEl.innerHTML = '<span class="chip chip-green">'+UNIT_ICON+' รวม '+Math.round(total).toLocaleString()+' kWh</span> '+
    avgChips + ' '+
    '<span class="chip" style="background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent-border)">'+data.length+' '+pl+'</span>';
}

var g9State = { period:'day', sort:'default', showPct:false };
function setG9Period(p){
  g9State.period = p;
  ['day','month','year'].forEach(function(k){
    var el = document.getElementById('g9-p-'+k);
    if(el) el.className = k===p ? 'ctrl-btn green' : 'ctrl-btn';
  });
  document.getElementById('g9-date').style.display = p==='day' ? '' : 'none';
  document.getElementById('g9-month').style.display = p==='month' ? '' : 'none';
  document.getElementById('g9-year').style.display = p==='year' ? '' : 'none';
  renderG9Chart();
}
function setG9Sort(s){
  g9State.sort = s;
  ['default','desc','asc'].forEach(function(k){
    var el = document.getElementById('g9-s-'+k);
    if(el) el.className = k===s ? 'ctrl-btn green' : 'ctrl-btn';
  });
  renderG9Chart();
}
function toggleG9Pct(){
  g9State.showPct = !g9State.showPct;
  var el = document.getElementById('g9-pct');
  if(el) el.className = g9State.showPct ? 'ctrl-btn on' : 'ctrl-btn';
  renderG9Chart();
}
function navG9(dir){
  if(g9State.period === 'day'){
    var el = document.getElementById('g9-date');
    var d = new Date(el.value); d.setDate(d.getDate()+dir);
    el.value = ymdLocal(d);
  } else if(g9State.period === 'month'){
    var el = document.getElementById('g9-month');
    var p = el.value.split('-').map(Number);
    var nd = new Date(p[0],p[1]-1+dir,1);
    el.value = nd.getFullYear()+'-'+String(nd.getMonth()+1).padStart(2,'0');
  } else {
    var el = document.getElementById('g9-year');
    el.value = String(parseInt(el.value)+dir);
  }
  renderG9Chart();
}
function initG9Pickers(){
  // Default the pickers to the most recent day/month we actually have loaded,
  // but build the YEAR list from the calendar — the year <select> is the only
  // one of the three that can't be typed into freely, so deriving it from
  // `records` would hard-block older years whenever the admin record window is
  // narrow. The chart data itself is fetched server-side per selected range.
  var dates = [];
  records.forEach(function(r){ var d = String(r.date).slice(0,10); if(d && dates.indexOf(d)<0) dates.push(d); });
  dates.sort();

  // Years that actually contain data — derived from the server-provided month
  // list, falling back to the loaded records if it hasn't arrived yet.
  var srcMonths = (availableMonths && availableMonths.length)
    ? availableMonths
    : dates.map(function(d){ return d.slice(0,7); });
  var years = [];
  srcMonths.forEach(function(m){ var y = m.slice(0,4); if(y && years.indexOf(y) < 0) years.push(y); });
  years.sort().reverse();
  if(!years.length) years = [String(new Date().getFullYear())];
  var thisYear = years[0];
  var ySel = document.getElementById('g9-year');
  if(ySel){
    var prevYear = ySel.value;
    ySel.innerHTML = years.map(function(y){return '<option value="'+y+'">'+y+'</option>';}).join('');
    ySel.value = (prevYear && years.indexOf(prevYear) >= 0) ? prevYear : String(thisYear);
  }

  if(!dates.length) return;
  document.getElementById('g9-date').value = dates.length >= 2 ? dates[dates.length-2] : dates[dates.length-1];
  var months = []; dates.forEach(function(d){ var m=d.slice(0,7); if(months.indexOf(m)<0) months.push(m); }); months.sort();
  document.getElementById('g9-month').value = months[months.length-1] || '';
}

let g9ReqId = 0;
async function renderG9Chart(){
  var thisReq = ++g9ReqId;
  var el = document.getElementById('g9-chart-el');
  var sumEl = document.getElementById('g9-chart-summary');
  var TC = getThemeColors();
  var MN = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var pick;
  if(g9State.period === 'day') pick = document.getElementById('g9-date').value;
  else if(g9State.period === 'month') pick = document.getElementById('g9-month').value;
  else pick = document.getElementById('g9-year').value;
  if(!pick){ el.innerHTML='<div class="section-empty">เลือกช่วงเวลา</div>'; return; }
  var lbl = document.getElementById('g9-label');
  if(g9State.period==='day'){ var pp=pick.split('-'); lbl.textContent=parseInt(pp[2])+' '+MN[parseInt(pp[1])]+' '+pp[0]; }
  else if(g9State.period==='month'){ var pp=pick.split('-'); lbl.textContent=MN[parseInt(pp[1])]+' '+pp[0]; }
  else lbl.textContent = 'ปี '+pick;
  el.innerHTML='<div class="section-empty">⏳ กำลังคำนวณ...</div>';
  var dateFrom, dateTo;
  if(g9State.period==='day'){
    dateFrom = pick;
    var d = new Date(pick); d.setDate(d.getDate()+7);
    dateTo = ymdLocal(d);
  } else if(g9State.period==='month'){
    var pp = pick.split('-');
    dateFrom = pick+'-01';
    var nd = new Date(parseInt(pp[0]),parseInt(pp[1]),7);
    dateTo = ymdLocal(nd);
  } else {
    dateFrom = pick+'-01-01';
    dateTo = (parseInt(pick)+1)+'-01-07';
  }
  try{
    var res = await getSummaryCached(dateFrom, dateTo, 'day');
    if(thisReq !== g9ReqId) return;
    if(!res||!res.success) throw new Error(res&&res.error||'error');
    var raw = res.summary || [];
    var meterMap = {};
    raw.forEach(function(r){ if(!meterMap[r.meterId]) meterMap[r.meterId]={}; meterMap[r.meterId][r.period]={firstKwh:r.firstKwh,lastKwh:r.lastKwh}; });
    var allPeriods = []; raw.forEach(function(r){ if(allPeriods.indexOf(r.period)<0) allPeriods.push(r.period); }); allPeriods.sort();
    var countPeriods;
    if(g9State.period==='day') countPeriods = [pick];
    else countPeriods = allPeriods.filter(function(p){return p.startsWith(pick);});
    // "กลุ่มหลัก" chart — main groups only. In apps without a `type` column
    // (or where every row is 'main'), this behaves the same as showing all groups.
    var _mainOnly = reportGroups.filter(function(g){ return !g.type || g.type === 'main'; });
    var groupVals = _mainOnly.map(function(col){
      var total = 0;
      countPeriods.forEach(function(p){
        (col.meters||[]).forEach(function(id){ if(!_countsTowardEnergy(id)) return; var u=meterUsedOnDay(meterMap,id,p,allPeriods); if(u!==null) total+=u; });
        (col.minus||[]).forEach(function(id){ if(!_countsTowardEnergy(id)) return; var u=meterUsedOnDay(meterMap,id,p,allPeriods); if(u!==null) total-=u; });
      });
      return { name:col.name, value:total, color:col.color||TC.accent };
    });
    if(g9State.sort==='desc') groupVals.sort(function(a,b){return b.value-a.value;});
    else if(g9State.sort==='asc') groupVals.sort(function(a,b){return a.value-b.value;});
    var total = groupVals.reduce(function(a,g){return a+g.value;},0);
    var top = groupVals.reduce(function(a,g){return g.value>a.value?g:a;}, groupVals[0]);
    var tooltipFmt = g9State.showPct
      ? function(v){ return Math.round(v).toLocaleString()+' '+UNIT+' ('+(total>0?((v/total)*100).toFixed(1):'0')+'%)'; }
      : function(v){ return v!=null?Math.round(v).toLocaleString()+' '+UNIT:'—'; };
    var opts = {
      chart:{ type:'bar', height:320, fontFamily:'IBM Plex Mono,monospace', foreColor:TC.text2,
        toolbar:{ show:true, tools:{download:true,zoom:true,zoomin:true,zoomout:true,pan:true,reset:true} },
        background:'transparent', animations:{enabled:true,speed:400} },
      series:[{ name:UNIT_WORD+' ('+UNIT+')', data:groupVals.map(function(g){return Math.round(g.value);}) }],
      xaxis:{ categories:groupVals.map(function(g){return g.name;}), axisBorder:{color:TC.border}, axisTicks:{show:false}, labels:{rotate:-45, rotateAlways:true, hideOverlappingLabels:false, trim:true, maxHeight:80, style:{fontSize:'9px',colors:TC.text3}} },
      yaxis:{ labels:{style:{fontSize:'11px',colors:TC.text2}, formatter:function(v){return Math.round(v).toLocaleString();}}, axisBorder:{show:false} },
      grid:{ borderColor:TC.border, strokeDashArray:3, xaxis:{lines:{show:false}}, yaxis:{lines:{show:true}} },
      tooltip:{ theme:TC.isDark?'dark':'light', style:{fontSize:'12px'}, y:{formatter:tooltipFmt} },
      colors:groupVals.map(function(g){return g.color;}),
      responsive:[{ breakpoint:640, options:{ chart:{height:300}, xaxis:{labels:{rotate:-55, rotateAlways:true, hideOverlappingLabels:false, trim:true, maxHeight:100, style:{fontSize:'8px'}}}, plotOptions:{bar:{columnWidth:'75%'}} } }],
      plotOptions:{ bar:{borderRadius:6,columnWidth:'65%',distributed:true} },
      fill:{ opacity:0.7 },
      legend:{ show:false },
      dataLabels:{ enabled:false },
      states:{ hover:{filter:{type:'lighten',value:0.08}} }
    };
    await ensureApex();
    if(thisReq !== g9ReqId) return;
    safeDestroyChart(g9ChartInst);
    el.innerHTML = '';
    g9ChartInst = new ApexCharts(el, opts);
    g9ChartInst.render();
    sumEl.innerHTML = '<span class="chip chip-green">'+UNIT_ICON+' รวม '+Math.round(total).toLocaleString()+' kWh</span> '+
      '<span class="chip" style="background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent-border)">🏭 สูงสุด: '+top.name+'</span>';
  }catch(e){ el.innerHTML='<div class="warn-box">❌ '+e.message+'</div>'; }
}

function buildCompareGroupOptions(){
  const sel = document.getElementById('cmp-group');
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = reportGroups.map(c => `<option value="${c.key}">${esc(c.name)}</option>`).join('')
    + '<option value="__TOTAL__">TOTAL (ทุกกลุ่ม)</option>';
  if(prev) sel.value = prev;
}
function getColIds(key){
  if(key === '__TOTAL__') return reportGroups.flatMap(c => c.meters || []);
  const col = reportGroups.find(c => c.key === key);
  return col ? (col.meters || []) : [];
}
/* A totalising register that is in service never legitimately reads 0, so a 0
   here means "nobody wrote anything down", not "nothing was used". Treating it
   as a real reading is actively destructive: the day before it computes
   max(0, 0 − R) = 0 and silently loses that day's real consumption, while the
   day itself computes R(next) − 0 and invents a spike the size of the entire
   lifetime register. Both the monthly total and any peak analysis would be
   wrong. Demand meters are excluded from this rule — they genuinely do read 0
   at the start of a billing cycle, right after the monthly reset. */
function _isUsableReading(meterId, v){
  if(v === null || v === undefined || isNaN(v)) return false;
  const meter = subs.find(s => s.id === meterId);
  const vt = meterValueType(meter);
  if(vt === 'demand') return true;          // 0 is a real value at cycle start
  return Number(v) !== 0;
}

/* Group totals are kWh — only a totalising register may contribute.
   meterUsedOnDay() already returns null for demand/snapshot, but a counter
   legitimately returns a number (events elapsed), and if one is listed in a
   group's `meters` that count would be summed into the energy figure with no
   visible sign. Every place that adds meters together goes through this.
   Lives in core, not in a module: core-tail's chart aggregation calls it, so a
   build without the Electric summary module would otherwise crash. */
function _countsTowardEnergy(meterId){
  return meterValueType(subs.find(s => s.id === meterId)) === 'cumulative';
}

function meterUsedOnDay(meterMap, meterId, dateStr, allDates){
  const cur = meterMap[meterId]?.[dateStr];
  if(!cur || !_isUsableReading(meterId, cur.firstKwh)) return null;
  // Reports and charts consume this directly; demand/snapshot have no daily
  // consumption to report, so they must not produce a number here either.
  const _vt = meterValueType(subs.find(s => s.id === meterId));
  if(_vt === 'demand' || _vt === 'snapshot') return null;
  const sub  = subs.find(s => s.id === meterId);
  const mult = sub?.multiplier !== undefined ? parseFloat(sub.multiplier) : 1;
  const idx = allDates.indexOf(dateStr);
  for(let k = idx+1; k < allDates.length; k++){
    const next = meterMap[meterId]?.[allDates[k]];
    if(next && _isUsableReading(meterId, next.firstKwh)){
      return Math.max(0, next.firstKwh - cur.firstKwh) * mult;
    }
  }
  return Math.max(0, cur.lastKwh - cur.firstKwh) * mult;
}

/* How many calendar days the figure from meterUsedOnDay actually covers.
   1 = normal. Greater than 1 means readings in between were missing or unusable,
   so the whole gap has been attributed to this one day. The tables mark those
   cells rather than quietly showing an inflated number as if it were a
   single day's use. */
function meterSpanOnDay(meterMap, meterId, dateStr, allDates){
  const cur = meterMap[meterId]?.[dateStr];
  if(!cur || !_isUsableReading(meterId, cur.firstKwh)) return 0;
  const idx = allDates.indexOf(dateStr);
  for(let k = idx+1; k < allDates.length; k++){
    const next = meterMap[meterId]?.[allDates[k]];
    if(next && _isUsableReading(meterId, next.firstKwh)){
      const d1 = new Date(dateStr + 'T00:00:00');
      const d2 = new Date(allDates[k] + 'T00:00:00');
      return Math.max(1, Math.round((d2 - d1) / 86400000));
    }
  }
  return 1;
}

var cmpState = { period:'day', type:'bar', showAvg:true };
function setCmpQuick(key){
  var r = getQuickRange(key);
  document.getElementById('cmp-from').value = r[0];
  document.getElementById('cmp-to').value = r[1];
  renderCmpChart();
}
function setCmpPeriod(p){
  cmpState.period = p;
  ['day','month','year'].forEach(function(k){
    var el = document.getElementById('cmp-p-'+k);
    if(el) el.className = k===p ? 'ctrl-btn green' : 'ctrl-btn';
  });
  renderCmpChart();
}
function setCmpType(t){
  cmpState.type = t;
  ['bar','line'].forEach(function(k){
    var el = document.getElementById('cmp-t-'+k);
    if(el) el.className = k===t ? 'ctrl-btn green' : 'ctrl-btn';
  });
  renderCmpChart();
}
function toggleCmpOpt(){
  cmpState.showAvg = !cmpState.showAvg;
  var el = document.getElementById('cmp-avg');
  if(el) el.className = cmpState.showAvg ? 'ctrl-btn on' : 'ctrl-btn';
  renderCmpChart();
}

let cmpReqId = 0;
function _cmpFillPeriods(allPeriods, fromVal, toVal, period){
  if(!allPeriods.length && !(fromVal && toVal)) return [];
  var pad = function(n){ return String(n).padStart(2,'0'); };
  if(period === 'day'){
    var start = fromVal || allPeriods[0];
    var end   = toVal   || allPeriods[allPeriods.length-1];
    if(!start || !end) return allPeriods.slice();
    var out = [];
    var cur = new Date(start+'T00:00:00');
    var stop = new Date(end+'T00:00:00');
    if((stop - cur)/86400000 > 400) return allPeriods.slice();
    while(cur <= stop){
      out.push(cur.getFullYear()+'-'+pad(cur.getMonth()+1)+'-'+pad(cur.getDate()));
      cur.setDate(cur.getDate()+1);
    }
    return out;
  }
  var startM = (fromVal ? fromVal.slice(0,7) : (allPeriods[0]||'').slice(0,7));
  var endM   = (toVal   ? toVal.slice(0,7)   : (allPeriods[allPeriods.length-1]||'').slice(0,7));
  if(!startM || !endM) return allPeriods.slice();
  var sp = startM.split('-').map(Number);
  var ep = endM.split('-').map(Number);
  var out2 = [];
  var y=sp[0], m=sp[1];
  var guard=0;
  while((y < ep[0] || (y===ep[0] && m <= ep[1])) && guard++ < 400){
    out2.push(y+'-'+pad(m));
    m++; if(m>12){ m=1; y++; }
  }
  return out2;
}

async function renderCmpChart(){
  var thisReq = ++cmpReqId;
  var groupKey = document.getElementById('cmp-group').value;
  var el = document.getElementById('cmp-chart-el');
  var sumEl = document.getElementById('cmp-chart-summary');
  if(!groupKey){ el.innerHTML='<div class="section-empty">เลือกกลุ่ม</div>'; return; }
  var ids = getColIds(groupKey);
  var fromVal = document.getElementById('cmp-from').value || null;
  var toVal = document.getElementById('cmp-to').value || null;
  var TC = getThemeColors();
  var MN = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  el.innerHTML='<div class="section-empty">⏳ กำลังคำนวณ...</div>';
  try{
    var gran = cmpState.period === 'day' ? 'day' : 'month';
    var apiToVal = toVal;
    if(toVal){
      var extD = new Date(toVal+'T00:00:00');
      extD.setDate(extD.getDate() + 7);
      apiToVal = ymdLocal(extD);
    }
    var res = await getSummaryCached(fromVal, apiToVal, gran);
    if(thisReq !== cmpReqId) return;
    if(!res||!res.success) throw new Error(res&&res.error||'error');
    var raw = res.summary || [];
    var meterMap = {};
    raw.forEach(function(r){ if(!meterMap[r.meterId]) meterMap[r.meterId]={}; meterMap[r.meterId][r.period]={firstKwh:r.firstKwh,lastKwh:r.lastKwh}; });
    var allPeriods = []; raw.forEach(function(r){ if(allPeriods.indexOf(r.period)<0) allPeriods.push(r.period); }); allPeriods.sort();
    var dataPoints;
    if(cmpState.period === 'year'){
      var displayPeriods = allPeriods.filter(function(p){
        if(fromVal && p < fromVal) return false;
        if(toVal && p > toVal) return false;
        return true;
      });
      var byYear = {};
      displayPeriods.forEach(function(p){ ids.forEach(function(id){ if(!_countsTowardEnergy(id)) return; var u=meterUsedOnDay(meterMap,id,p,allPeriods); if(u!==null) byYear[p.slice(0,4)]=(byYear[p.slice(0,4)]||0)+u; }); });
      dataPoints = Object.entries(byYear).map(function(e){return {label:e[0],value:e[1]};});
    } else {
      var valByPeriod = {};
      allPeriods.forEach(function(p){
        var total=0, has=false;
        ids.forEach(function(id){ if(!_countsTowardEnergy(id)) return; var u=meterUsedOnDay(meterMap,id,p,allPeriods); if(u!==null){total+=u;has=true;} });
        valByPeriod[p] = has ? total : 0;
      });
      var fullPeriods = _cmpFillPeriods(allPeriods, fromVal, toVal, cmpState.period);
      dataPoints = fullPeriods.map(function(p){
        var label;
        if(cmpState.period==='day') label=parseInt(p.split('-')[2])+'/'+parseInt(p.split('-')[1]);
        else label=MN[parseInt(p.split('-')[1])]+' '+p.slice(0,4);
        return { label:label, value:valByPeriod[p]||0, hol:(cmpState.period==='day' && getDayType(p)==='holiday') };
      });
    }
    if(!dataPoints.length){ el.innerHTML='<div class="section-empty">ไม่มีข้อมูล</div>'; return; }
    var total = dataPoints.reduce(function(a,d){return a+d.value;},0);
    var avg = dataPoints.length ? total/dataPoints.length : 0;
    var pl = cmpState.period==='day'?'วัน':cmpState.period==='month'?'เดือน':'ปี';
    var cmpAvgWork = 0, cmpAvgHol = 0, cmpNWork = 0, cmpNHol = 0;
    if(cmpState.period === 'day'){
      var cSumW = 0, cSumH = 0;
      dataPoints.forEach(function(d){
        if(d.hol){ cSumH += d.value; cmpNHol++; }
        else { cSumW += d.value; cmpNWork++; }
      });
      cmpAvgWork = cmpNWork ? cSumW/cmpNWork : 0;
      cmpAvgHol  = cmpNHol  ? cSumH/cmpNHol  : 0;
    }
    var values = dataPoints.map(function(d){return Math.round(d.value);});
    var labels = dataPoints.map(function(d){return d.label;});
    var series = [{ name:UNIT_WORD+' ('+UNIT+'/'+pl+')', data:values }];
    var chartColors = [TC.accent];
    var strokeW = cmpState.type==='bar' ? [0] : [2.5];
    var strokeDash = [0];
    if(cmpState.showAvg){
      var cmpAvgLine = Math.round(cmpState.period === 'day' ? cmpAvgWork : avg);
      series.push({ name:'ค่าเฉลี่ย', data:dataPoints.map(function(){return cmpAvgLine;}), type:'line' });
      chartColors.push(TC.orange+'77');
      strokeW = cmpState.type==='bar' ? [0,2] : [2.5,2]; strokeDash = [0,5];
    }
    var opts = {
      chart:{ type:cmpState.type==='bar'?'bar':'line', height:340, fontFamily:'IBM Plex Mono,monospace', foreColor:TC.text2,
        toolbar:{ show:true, tools:{download:true,zoom:true,zoomin:true,zoomout:true,pan:true,reset:true} },
        background:'transparent', animations:{enabled:true,speed:400} },
      series: series,
      xaxis:{ categories:labels, axisBorder:{color:TC.border}, axisTicks:{show:false}, labels:{rotate:0, rotateAlways:false, hideOverlappingLabels:true, trim:false, style:{fontSize:'10px',colors:TC.text3}} },
      yaxis:{ labels:{style:{fontSize:'11px',colors:TC.text2}, formatter:function(v){return Math.round(v).toLocaleString();}}, axisBorder:{show:false} },
      grid:{ borderColor:TC.border, strokeDashArray:3, xaxis:{lines:{show:false}}, yaxis:{lines:{show:true}} },
      tooltip:{ theme:TC.isDark?'dark':'light', style:{fontSize:'12px'}, y:{formatter:function(v){return v!=null?Math.round(v).toLocaleString()+' '+UNIT:'—';}} },
      colors: chartColors,
      responsive:[{ breakpoint:640, options:{ chart:{height:300}, xaxis:{labels:{rotate:-45, rotateAlways:true, hideOverlappingLabels:true, style:{fontSize:'8px'}}}, plotOptions:{bar:{columnWidth:'80%'}} } }],
      plotOptions:{ bar:{borderRadius:4,columnWidth:'70%'} },
      stroke:{ width:strokeW, dashArray:strokeDash },
      fill:{ opacity:cmpState.type==='bar'?0.6:0.7 },
      legend:{ fontSize:'11px', labels:{colors:TC.text2}, markers:{shape:'square',size:6} },
      dataLabels:{ enabled:false },
      states:{ hover:{filter:{type:'lighten',value:0.08}} }
    };
    await ensureApex();
    if(thisReq !== cmpReqId) return;
    safeDestroyChart(cmpChartInst);
    el.innerHTML = '';
    cmpChartInst = new ApexCharts(el, opts);
    cmpChartInst.render();
    var cmpAvgChips;
    if(cmpState.period === 'day' && (cmpNWork || cmpNHol)){
      cmpAvgChips = '<span class="chip chip-green">เฉลี่ยวันทำงาน '+Math.round(cmpAvgWork).toLocaleString()+' '+UNIT+' ('+cmpNWork+' วัน)</span> '+
                    '<span class="chip" style="background:rgba(251,146,60,.15);color:var(--orange);border:1px solid rgba(251,146,60,.4)">เฉลี่ยวันหยุด '+Math.round(cmpAvgHol).toLocaleString()+' '+UNIT+' ('+cmpNHol+' วัน)</span>';
    } else {
      cmpAvgChips = '<span class="chip chip-green">เฉลี่ย '+Math.round(avg).toLocaleString()+' '+UNIT+'/'+pl+'</span>';
    }
    sumEl.innerHTML = '<span class="chip chip-green">'+UNIT_ICON+' รวม '+Math.round(total).toLocaleString()+' kWh</span> ' + cmpAvgChips;
  }catch(e){ el.innerHTML='<div class="warn-box">❌ '+e.message+'</div>'; }
}



/* ═══════════════════════════════════════════════════════════
   REDESIGN SHIM — sidebar drawer + login toggle + search
   No handler renames; every user action ultimately calls the
   original functions (goTab, handleLogin, handleRecorderLogin).
   =========================================================== */
function rdOpenDrawer(){
  document.getElementById('rd-drawer')?.classList.add('open');
  document.getElementById('rd-drawer-overlay')?.classList.add('open');
  rdSyncDrawerUser();
  rdSyncDrawerActive();
  rdApplyRoleVisibility();
}
function rdCloseDrawer(){
  document.getElementById('rd-drawer')?.classList.remove('open');
  document.getElementById('rd-drawer-overlay')?.classList.remove('open');
}
function rdGoTab(name){
  try { goTab(name); } catch (e) { console.warn('goTab failed', e); }
  rdCloseDrawer();
  // update active item
  document.querySelectorAll('.rd-drawer-item[data-rd-tab]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-rd-tab') === name);
  });
}
function rdSyncDrawerActive(){
  // read the currently-visible panel to reflect it in the drawer
  const active = document.querySelector('.panel.active');
  if (!active) return;
  const name = active.id.replace(/^panel-/, '');
  document.querySelectorAll('.rd-drawer-item[data-rd-tab]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-rd-tab') === name);
  });
}
function rdSyncDrawerUser(){
  // pull from existing globals set by the auth flow
  const uname = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : '';
  const mode  = (typeof appMode !== 'undefined') ? appMode : '';
  const box   = document.getElementById('rd-drawer-user');
  if (!box) return;
  const signedIn = !!(typeof sessionToken !== 'undefined' && sessionToken);
  if (!signedIn) {                      // signed out — hide identity + sign-out row
    box.style.display = 'none';
    const lo = document.getElementById('rd-logout-item');
    if (lo) lo.style.display = 'none';
    return;
  }
  if (!uname && !mode) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const av  = document.getElementById('rd-drawer-avatar');
  const un  = document.getElementById('rd-drawer-username');
  const rl  = document.getElementById('rd-drawer-role');
  if (av) av.textContent = (uname || mode || 'U').substring(0, 1).toUpperCase();
  if (un) un.textContent = uname || (mode === 'admin' ? 'Administrator' : 'Recorder');
  if (rl) rl.textContent = mode === 'admin' ? 'Admin access' : 'Recorder';
  const logout = document.getElementById('rd-logout-item');
  if (logout) logout.style.display = 'flex';
}
function rdApplyRoleVisibility(){
  // hide admin-only items when in recorder mode
  const mode = (typeof appMode !== 'undefined') ? appMode : '';
  document.querySelectorAll('.rd-admin-item').forEach(el => {
    el.classList.toggle('hidden', mode !== 'admin');
  });
}
// Login toggle handlers — delegate the actual show/hide to the ORIGINAL
// showAdminLogin()/showRecorderLogin() functions (they already toggle
// #login-choose/#login-recorder/#login-admin correctly and focus the
// right field). We only layer the new title/subtitle text on top.
function rdShowAdmin(){
  showAdminLogin();
  const tag = document.getElementById('rd-login-mode-tag');
  const title = document.getElementById('rd-login-title');
  const sub = document.getElementById('rd-login-subtitle');
  if (tag)   tag.textContent   = 'Admin access';
  if (title) title.textContent = 'Administrator sign-in';
  if (sub)   sub.textContent   = 'สำหรับผู้ดูแลระบบ / ทีม IT';
}
function rdShowRecorder(){
  showRecorderLogin();
  const tag = document.getElementById('rd-login-mode-tag');
  const title = document.getElementById('rd-login-title');
  const sub = document.getElementById('rd-login-subtitle');
  if (tag)   tag.textContent   = 'Recorder access';
  if (title) title.textContent = 'Sign in to log readings';
  if (sub)   sub.textContent   = 'กรอกรหัสผ่านทีมจดมิเตอร์เพื่อเริ่มบันทึกค่า';
}
// Keyboard: Enter in recorder passcode → submit
document.addEventListener('DOMContentLoaded', () => {
  // NOTE: Enter-key handlers for #login-user / #login-pass / #recorder-pass
  // are already bound by the ORIGINAL app.js (see its own DOMContentLoaded
  // listener near the bottom of the file). Since our markup now reuses those
  // exact IDs, binding them again here would double-fire handleLogin() /
  // handleRecorderLogin() on every Enter press — so we deliberately don't.

  // ESC closes drawer
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') rdCloseDrawer();
  });

  // Search: live filter on meter cards + Enter opens first match
  const search = document.getElementById('rd-search-input');
  if (search) {
    search.addEventListener('input', () => rdApplySearch(search.value));
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); rdOpenFirstMatch(); }
      if (e.key === 'Escape') { search.value = ''; rdApplySearch(''); }
    });
  }

  // Header title from CONFIG if present
  const title = document.getElementById('hdr-title');
  const code  = document.getElementById('rd-brand-code');
  if (title && typeof SITE_NAME !== 'undefined') {
    // rebuild inner: name + code badge
    title.innerHTML = SITE_NAME + (typeof SITE_CODE !== 'undefined' ? '<span class="rd-brand-code">' + SITE_CODE + '</span>' : '');
  }
});
function rdApplySearch(q){
  const query = (q || '').trim().toLowerCase();
  const cards = document.querySelectorAll('#zone-areas .sub-card');
  let visible = 0;
  cards.forEach(card => {
    if (!query) { card.style.display = ''; visible++; return; }
    const text = card.textContent.toLowerCase();
    const show = text.includes(query);
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  // hide zone sections that have no visible cards
  document.querySelectorAll('#zone-areas .zone-block').forEach(zone => {
    const anyVisible = Array.from(zone.querySelectorAll('.sub-card')).some(c => c.style.display !== 'none');
    zone.style.display = anyVisible ? '' : 'none';
  });
}
function rdOpenFirstMatch(){
  const first = Array.from(document.querySelectorAll('#zone-areas .sub-card'))
    .find(c => c.style.display !== 'none');
  if (first) first.click();
}
// Sync sync-dot status class from existing sync logic (poll)
// The original code sets background-color; we mirror it as class for the new dot.
setInterval(() => {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  const bg = getComputedStyle(dot).backgroundColor;
  dot.classList.remove('ok','working','err');
  // heuristic: existing app uses green/orange/red; classify by hue
  const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return;
  const [_, r, g, b] = m.map(Number);
  if (g > r && g > b) dot.classList.add('ok');
  else if (r > 200 && g > 100 && b < 100) dot.classList.add('working');
  else if (r > 200 && g < 100) dot.classList.add('err');
}, 500);

