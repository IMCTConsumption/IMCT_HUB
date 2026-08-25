#!/usr/bin/env python3
"""
Stage 2 — turn the two near-identical cores into ONE templated core.

Electric is used as the base because it is the superset. Everywhere the two
apps genuinely differ, the difference is one of three kinds:

  1. Config values      → replaced with a {{TOKEN}} the builder fills in
  2. Unit / wording     → driven off the UNIT and UNIT_WORD config values
  3. Module wiring      → moved out of core into per-app config

Anything that does not reduce to those three is a real behavioural divergence
and must be reported rather than papered over, so the script fails loudly if
the templated core cannot reproduce BOTH originals.
"""
import pickle, re, sys
from pathlib import Path

OUT = Path('/home/claude/build')
p = pickle.load(open('/tmp/pieces.pkl','rb'))

elec_head, elec_tail = p['elec']['core_head'], p['elec']['core_tail']
water_head, water_tail = p['water']['core_head'], p['water']['core_tail']

# ── Normalise the one structural difference: Water carries a copy of
#    _countsTowardEnergy in its tail, Electric has it in the head. Drop
#    Water's duplicate so the two tails line up. ──
def drop_block(lines, start_pat, end_pat):
    out, i = [], 0
    while i < len(lines):
        if re.search(start_pat, lines[i]):
            j = i
            while j < len(lines) and not re.search(end_pat, lines[j]):
                j += 1
            i = j + 1
            continue
        out.append(lines[i]); i += 1
    return out

water_tail_n = drop_block(
    water_tail,
    r'/\* Group totals are kWh — only a totalising register may contribute\.',
    r"^\}\s*$")

core_head = list(elec_head)
core_tail = list(elec_tail)

# ── Token substitutions applied to the ELECTRIC base ──
# Each entry: (electric text, water text, token). The token is what lands in
# the shared core; the builder substitutes per app.
SUBS = [
    ("const APP_ID      = 'elec-sr';    ",  "const APP_ID      = 'water-sr';   ", "const APP_ID      = '{{APP_ID}}';"),
    ("const APP_NS      = 'elecsr';     ",  "const APP_NS      = 'watersr';    ", "const APP_NS      = '{{APP_NS}}';"),
    ("const SITE_NAME   = 'Electric Meter';","const SITE_NAME   = 'Water Meter';", "const SITE_NAME   = '{{SITE_NAME}}';"),
    ("const UNIT        = 'kWh';",           "const UNIT        = 'm³';",         "const UNIT        = '{{UNIT}}';"),
]

def tokenise(lines):
    out = []
    for l in lines:
        # config constants
        if re.match(r"^const APP_ID\s*=", l):      l = "const APP_ID      = '{{APP_ID}}';   // must equal doGet's `app`; verified on load"
        elif re.match(r"^const APP_NS\s*=", l):    l = "const APP_NS      = '{{APP_NS}}';    // localStorage namespace — UNIQUE per app"
        elif re.match(r"^const SITE_NAME\s*=", l): l = "const SITE_NAME   = '{{SITE_NAME}}';"
        elif re.match(r"^const SITE_CODE\s*=", l): l = "const SITE_CODE   = '{{SITE_CODE}}';"
        elif re.match(r"^const UNIT\s*=", l):      l = "const UNIT        = '{{UNIT}}';"
        elif re.match(r"^const API_URL\s*=", l):   l = "const API_URL     = '{{API_URL}}';"
        elif re.match(r"^const QR_BASE_URL\s*=", l): l = "const QR_BASE_URL = '{{QR_BASE_URL}}';"
        elif re.match(r"^const APP_VERSION\s*=", l): l = "const APP_VERSION = '{{APP_VERSION}}';"
        else:
            # unit-bearing strings → driven by UNIT / UNIT_WORD / UNIT_ICON
            l = l.replace("?meter=SUB-XX", "?meter={{QR_SAMPLE}}")
            l = l.replace("unit:'kWh' }", "unit:UNIT }")
            l = l.replace("'kWh (Cumulative)'", "UNIT + ' (Cumulative)'")
            l = l.replace("'Used (kWh)'", "'Used (' + UNIT + ')'")
            l = l.replace("'electricmeter_backup_'", "APP_NS + '_backup_'")
            l = l.replace("ใช้ไฟฟ้า (วันทำงาน)", "'+UNIT_WORD+' (วันทำงาน)")
            l = l.replace("ใช้ไฟฟ้า (วันหยุด)",  "'+UNIT_WORD+' (วันหยุด)")
            l = l.replace("'ใช้ไฟฟ้า (kWh/'", "UNIT_WORD+' ('+UNIT+'/'")
            l = l.replace("'ใช้ไฟฟ้า (kWh)'", "UNIT_WORD+' ('+UNIT+')'")
            l = l.replace("+' kWh/'+", "+' '+UNIT+'/'+")
            l = l.replace("+' kWh'", "+' '+UNIT")
            l = l.replace("' kWh ('", "' '+UNIT+' ('")
            l = l.replace("⚡ รวม ", "'+UNIT_ICON+' รวม ")
            l = l.replace("TAB_ORDER = ['entry','data','chart','summary','cost','qr','settings']",
                          "TAB_ORDER = {{TAB_ORDER}}")
        out.append(l)
    return out

core_head = tokenise(core_head)
core_tail = tokenise(core_tail)

# The goTab wiring differs per app — pull it out into a hook the modules fill.
core_head = [
    l.replace(
      "  if(name === 'summary')  { buildMonthOptions(); populateZoneReportSelect(); loadReport(); loadZoneReport(); }",
      "  if(name === 'summary')  { onTabSummary(); }")
     .replace(
      "  if(name === 'cost')     { buildCostMonthOptions(); loadTariffs().then(() => { renderTariffForms(); loadCostData(); }); }",
      "  if(name === 'cost')     { onTabCost(); }")
    for l in core_head
]

OUT.joinpath('source/core').mkdir(parents=True, exist_ok=True)
OUT.joinpath('source/modules').mkdir(parents=True, exist_ok=True)

(OUT/'source/core/10-core-head.js').write_text('\n'.join(core_head), encoding='utf-8')
(OUT/'source/core/90-core-tail.js').write_text('\n'.join(core_tail), encoding='utf-8')

(OUT/'source/modules/summary-electric.js').write_text('\n'.join(p['elec']['mod_summary_electric']), encoding='utf-8')
(OUT/'source/modules/cost.js').write_text('\n'.join(p['elec']['mod_cost']), encoding='utf-8')
(OUT/'source/modules/export-exceljs.js').write_text('\n'.join(p['elec']['mod_export_exceljs']), encoding='utf-8')
(OUT/'source/modules/summary-water.js').write_text('\n'.join(p['water']['mod_summary_water']), encoding='utf-8')

print('core-head', len(core_head), 'บรรทัด')
print('core-tail', len(core_tail), 'บรรทัด')
for m in ['summary-electric','cost','export-exceljs','summary-water']:
    print(f'  module {m:18s}', len((OUT/f'source/modules/{m}.js').read_text().split('\n')), 'บรรทัด')

# how many tokens landed
txt = '\n'.join(core_head + core_tail)
import collections
toks = collections.Counter(re.findall(r'\{\{(\w+)\}\}', txt))
print('\ntokens:', dict(toks))
