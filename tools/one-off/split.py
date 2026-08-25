#!/usr/bin/env python3
"""
Split the two hand-maintained index.html files into a shared core plus
app-specific modules.

The split is done by CUTTING, never by rewriting: every line ends up in exactly
one output file with its content untouched. build.js then concatenates them back
in a fixed order, and verify.py diffs the result against the original. If the
rebuild is not byte-identical (modulo the config block), something was lost and
the split is wrong.
"""
import re, sys, json
from pathlib import Path

SRC = Path('/home/claude/redesign')
OUT = Path('/home/claude/build')

def parts(path):
    h = path.read_text(encoding='utf-8')
    css = re.search(r'<style>(.*?)</style>', h, re.S)
    js  = re.search(r'<script>(.*?)</script>', h, re.S)
    return h, css, js

def find_line(lines, pattern, start=0):
    """Index of the first line matching pattern, at or after `start`."""
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    return -1

# ─────────────────────────────────────────────────────────────
# ELECTRIC — the richer of the two; its module boundaries define the layout
# ─────────────────────────────────────────────────────────────
he, csse, jse = parts(SRC / 'electric_new.html')
el = jse.group(1).split('\n')

# Boundaries, located by their section banners rather than fixed numbers so a
# shifted line does not silently move a cut.
b_excel  = find_line(el, r'MONTHLY REPORT — ExcelJS export helpers')
b_report = find_line(el, r'MONTHLY REPORT \(SR-Electric\)')
b_cost   = find_line(el, r'COST ESTIMATION \(Electric only\)')
b_apex   = find_line(el, r'APEXCHARTS SYSTEM')

for name, v in [('excel',b_excel),('report',b_report),('cost',b_cost),('apex',b_apex)]:
    if v < 0:
        sys.exit(f'ELECTRIC: boundary "{name}" not found')
if not (b_excel < b_report < b_cost < b_apex):
    sys.exit(f'ELECTRIC: boundaries out of order: {b_excel} {b_report} {b_cost} {b_apex}')

# Banners start a few lines above the marker text; step back to the comment open.
def banner_start(lines, idx):
    i = idx
    while i > 0 and not re.match(r'^/\*\s*═|^// ═', lines[i]):
        i -= 1
        if idx - i > 6: return idx      # not a banner — cut at the marker
    return i

s_excel  = banner_start(el, b_excel)
s_report = banner_start(el, b_report)
s_cost   = banner_start(el, b_cost)
s_apex   = banner_start(el, b_apex)

elec_pieces = {
    'core_head'          : el[:s_excel],                 # config → entry → data → settings
    'mod_export_exceljs' : el[s_excel:s_report],         # Electric only
    'mod_summary_electric': el[s_report:s_cost],         # Electric only
    'mod_cost'           : el[s_cost:s_apex],            # Electric only
    'core_tail'          : el[s_apex:],                  # charts + redesign shim
}

# ─────────────────────────────────────────────────────────────
# WATER — same head/tail, its own summary module
# ─────────────────────────────────────────────────────────────
hw, cssw, jsw = parts(SRC / 'water_new.html')
wl = jsw.group(1).split('\n')

w_sum  = find_line(wl, r'SUMMARY: month-based, 2 tables')
w_apex = find_line(wl, r'APEXCHARTS SYSTEM')
if w_sum < 0 or w_apex < 0 or not (w_sum < w_apex):
    sys.exit(f'WATER: boundaries bad ({w_sum}, {w_apex})')
sw_sum  = banner_start(wl, w_sum)
sw_apex = banner_start(wl, w_apex)

water_pieces = {
    'core_head'        : wl[:sw_sum],
    'mod_summary_water': wl[sw_sum:sw_apex],
    'core_tail'        : wl[sw_apex:],
}

# ─────────────────────────────────────────────────────────────
# Report what the cut produced, before writing anything
# ─────────────────────────────────────────────────────────────
print('ELECTRIC')
for k, v in elec_pieces.items():
    print(f'   {k:22s} {len(v):5d} บรรทัด')
print(f'   {"รวม":22s} {sum(len(v) for v in elec_pieces.values()):5d}  (ต้นฉบับ {len(el)})')
print('\nWATER')
for k, v in water_pieces.items():
    print(f'   {k:22s} {len(v):5d} บรรทัด')
print(f'   {"รวม":22s} {sum(len(v) for v in water_pieces.values()):5d}  (ต้นฉบับ {len(wl)})')

assert sum(len(v) for v in elec_pieces.values()) == len(el),  'ELECTRIC: line count mismatch'
assert sum(len(v) for v in water_pieces.values()) == len(wl), 'WATER: line count mismatch'

# ─────────────────────────────────────────────────────────────
# How similar are the two cores? That number decides whether one shared core
# is honest or whether we would be papering over real divergence.
# ─────────────────────────────────────────────────────────────
import difflib
eh, wh = elec_pieces['core_head'], water_pieces['core_head']
et, wt = elec_pieces['core_tail'], water_pieces['core_tail']
def sim(a, b):
    sm = difflib.SequenceMatcher(None, a, b)
    return sum(bl.size for bl in sm.get_matching_blocks())
print(f'\ncore_head เหมือนกัน {sim(eh,wh)}/{len(eh)} = {sim(eh,wh)/len(eh)*100:.0f}%')
print(f'core_tail เหมือนกัน {sim(et,wt)}/{len(et)} = {sim(et,wt)/len(et)*100:.0f}%')

json.dump(
    {'elec': {k: len(v) for k, v in elec_pieces.items()},
     'water': {k: len(v) for k, v in water_pieces.items()}},
    open('/tmp/split_report.json', 'w'), indent=2)

# stash the pieces for the next stage
import pickle
pickle.dump({'elec': elec_pieces, 'water': water_pieces,
             'elec_html': he, 'water_html': hw,
             'elec_css': csse.group(1), 'water_css': cssw.group(1)},
            open('/tmp/pieces.pkl', 'wb'))
print('\nstashed → /tmp/pieces.pkl')
