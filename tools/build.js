#!/usr/bin/env node
/**
 * build.js — assemble each app's index.html from the shared source.
 *
 *   source/core/10-core-head.js   shared, templated
 *   source/modules/*.js           picked per app by config.modules
 *   source/core/90-core-tail.js   shared, templated
 *   source/style.css              shared verbatim
 *   source/shell-<shell>.html     markup, with {{STYLE}} / {{SCRIPT}} slots
 *   config/<app>.json             the only per-app input
 *
 * Output: dist/<app>/index.html — self-contained, deployable on its own.
 *
 * Module order matters: modules land between head and tail so that they can
 * use core helpers, and so the tail's chart code can call into them.
 *
 * Run:  node tools/build.js          (all apps)
 *       node tools/build.js elec-sr  (one app)
 */
const fs = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const SRC     = path.join(ROOT, 'source');
const CONFIG  = path.join(ROOT, 'config');
const DIST    = path.join(ROOT, 'dist');

function read(p) { return fs.readFileSync(p, 'utf8'); }

function fill(text, cfg) {
  // Replace every {{TOKEN}} with its config value. An unfilled token is a
  // build error rather than something that ships: a stray {{API_URL}} in a
  // deployed file would fail at runtime with no obvious cause.
  const out = text.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in cfg)) return m;                 // leave for the caller to catch
    const v = cfg[key];
    return Array.isArray(v) ? JSON.stringify(v) : String(v);
  });
  return out;
}


/* ── Backend: core + per-app seed + optional modules → one Code.gs ──
   Apps Script takes a single pasted file, so the pieces are concatenated here
   rather than shipped separately. Module doPost cases are spliced into the
   {{BACKEND_CASES}} slot in core so a build without a module simply has no
   case for it, instead of a case calling a function that isn't there. */

/* Seed passwords deliberately do NOT live in this repo — it is public, and a
   password sitting next to the API URL it unlocks is worse than the mild
   inconvenience of setting it by hand. They are placeholders here and must be
   filled in inside the Apps Script editor after pasting Code.gs.
   The value only matters the first time a _USERS sheet is created; after that
   the sheet holds a hash and this constant is never read again. */
function checkSeedPasswords(appName, cfg) {
  const be = cfg.backend || {};
  const bad = ['ADMIN_SEED_PW', 'RECORDER_SEED_PW']
    .filter(k => String(be[k] || '').startsWith('CHANGE_ME'));
  return bad;
}

function buildBackend(appName, cfg) {
  const B = path.join(SRC, 'backend');
  const be = cfg.backend || {};
  let core = read(path.join(B, 'core.gs'));

  const caseParts = [];
  const bodyParts = [];
  for (const m of (be.modules || [])) {
    const mp = path.join(B, 'modules', m + '.gs');
    if (!fs.existsSync(mp)) throw new Error(`${appName}: missing backend module ${m}`);
    bodyParts.push(read(mp));
    const cp = path.join(B, 'modules', m + '.cases.gs');
    if (fs.existsSync(cp)) caseParts.push(read(cp));
  }
  core = core.replace('{{BACKEND_CASES}}', () => caseParts.join('\n\n'));

  const seedPath = path.join(B, 'seeds', be.seed + '.gs');
  if (!fs.existsSync(seedPath)) throw new Error(`${appName}: missing seed ${be.seed}`);

  let out = [core, bodyParts.join('\n\n'), read(seedPath)].filter(Boolean).join('\n\n');
  out = fill(out, Object.assign({}, cfg, be, { UNIT: be.UNIT_BACKEND || cfg.UNIT }));

  const leftover = out.match(/\{\{(\w+)\}\}/g);
  if (leftover) throw new Error(`${appName} backend: unfilled ${[...new Set(leftover)].join(', ')}`);

  const outDir = path.join(DIST, appName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'Code.gs'), out, 'utf8');
  return out.length;
}

function buildApp(appName) {
  const cfgPath = path.join(CONFIG, appName + '.json');
  if (!fs.existsSync(cfgPath)) throw new Error('no config: ' + appName);
  const cfg = JSON.parse(read(cfgPath));

  // ── JS: head → modules (in config order) → tail ──
  const jsParts = [ read(path.join(SRC, 'core/10-core-head.js')) ];
  for (const m of (cfg.modules || [])) {
    const mp = path.join(SRC, 'modules', m + '.js');
    if (!fs.existsSync(mp)) throw new Error(`${appName}: missing module ${m}`);
    jsParts.push(read(mp));
  }
  jsParts.push(read(path.join(SRC, 'core/90-core-tail.js')));

  // Tab hooks: core calls onTabSummary()/onTabCost(); which module answers
  // depends on the app, so the wiring is generated here rather than living in
  // core with an if-chain that knows every app.
  const hooks = [];
  hooks.push('/* ── generated tab hooks (see build.js) ── */');
  if ((cfg.modules || []).includes('summary-electric')) {
    hooks.push('function onTabSummary(){ buildMonthOptions(); populateZoneReportSelect(); loadReport(); loadZoneReport(); }');
  } else if ((cfg.modules || []).includes('summary-water')) {
    hooks.push('function onTabSummary(){ renderSummary(); }');
  } else {
    hooks.push('function onTabSummary(){ /* no summary module in this build */ }');
  }
  if ((cfg.modules || []).includes('cost')) {
    hooks.push('function onTabCost(){ buildCostMonthOptions(); loadTariffs().then(() => { renderTariffForms(); loadCostData(); }); }');
  } else {
    hooks.push('function onTabCost(){ /* no cost module in this build */ }');
  }
  jsParts.push(hooks.join('\n'));

  let js = fill(jsParts.join('\n'), cfg);

  // UNIT_WORD / UNIT_ICON are referenced as bare identifiers by the templated
  // core, so they need real declarations. They sit right after the config
  // block so everything below can see them.
  const decl = `const UNIT_WORD = ${JSON.stringify(cfg.UNIT_WORD)};\n` +
               `const UNIT_ICON = ${JSON.stringify(cfg.UNIT_ICON)};`;
  js = js.replace(/(const QR_BASE_URL = '[^']*';)/, `$1\n${decl}`);

  const css   = read(path.join(SRC, 'style.css'));
  const shell = read(path.join(SRC, `shell-${cfg.shell}.html`));

  let html = shell.replace('{{STYLE}}', () => css)
                  .replace('{{SCRIPT}}', () => js);
  html = fill(html, cfg);

  const leftover = html.match(/\{\{(\w+)\}\}/g);
  if (leftover) throw new Error(`${appName}: unfilled tokens ${[...new Set(leftover)].join(', ')}`);

  const outDir = path.join(DIST, appName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

  const beBytes = buildBackend(appName, cfg);
  const pwWarn = checkSeedPasswords(appName, cfg);
  return { app: appName, bytes: html.length, beBytes, modules: cfg.modules || [], pwWarn };
}

const only = process.argv[2];
const apps = only ? [only]
                  : fs.readdirSync(CONFIG).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));

let failed = 0;
for (const a of apps) {
  try {
    const r = buildApp(a);
    console.log(`  ✅ ${r.app.padEnd(10)} html ${(r.bytes/1024).toFixed(0).padStart(4)} KB · Code.gs ${(r.beBytes/1024).toFixed(0).padStart(3)} KB   modules: ${r.modules.join(', ') || '(none)'}`);
    if (r.pwWarn.length) {
      console.log(`     ⚠️  ${r.pwWarn.join(' + ')} ยังเป็น placeholder — ตั้งค่าใน Apps Script หลัง paste Code.gs`);
    }
    const cfgCheck = JSON.parse(read(path.join(CONFIG, r.app + '.json')));
    if (String(cfgCheck.API_URL).startsWith('PASTE_')) {
      console.log(`     ⚠️  API_URL ยังไม่ได้ตั้ง — แอปนี้ยังใช้งานไม่ได้`);
    }
  } catch (e) {
    console.error(`  ❌ ${a}: ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
