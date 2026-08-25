#!/usr/bin/env python3
"""
Split Code.gs the same way as the frontend: one shared core, per-app seeds,
and Electric-only modules. Apps Script still receives a single pasted file —
build.js concatenates the pieces — but there is now one place to fix a bug.
"""
import re, sys
from pathlib import Path

ORIG  = Path('/home/claude/redesign')
BUILD = Path('/home/claude/build')
(BUILD/'source/backend').mkdir(parents=True, exist_ok=True)
(BUILD/'source/backend/seeds').mkdir(parents=True, exist_ok=True)
(BUILD/'source/backend/modules').mkdir(parents=True, exist_ok=True)

e = (ORIG/'electric_Code.gs').read_text(encoding='utf-8')
w = (ORIG/'water_Code.gs').read_text(encoding='utf-8')

def cut_function(src, name):
    """Return (function_text, src_without_it). Brace-matched, comment-aware."""
    m = re.search(rf'^function {re.escape(name)}\s*\(', src, re.M)
    if not m:
        return None, src
    start = m.start()
    # include the banner comment directly above, if any
    head = src.rfind('\n// ====', 0, start)
    if head != -1 and start - head < 2000:
        start = head + 1
    i = src.index('{', m.start())
    depth, j = 0, i
    while j < len(src):
        if src[j] == '{': depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0: break
        j += 1
    return src[start:j+1], src[:start] + src[j+1:]

# ── Electric-only: the whole tariff section ──
tariff_start = e.find('// ============================================================\n//  TARIFFS')
tariff_end   = e.find('// ============================================================\n//  USERS')
if tariff_start < 0 or tariff_end < 0 or tariff_start >= tariff_end:
    sys.exit('could not locate the tariff section')
tariffs = e[tariff_start:tariff_end]
e_core  = e[:tariff_start] + e[tariff_end:]
(BUILD/'source/backend/modules/tariffs.gs').write_text(tariffs, encoding='utf-8')
print(f'  modules/tariffs.gs        {len(tariffs.splitlines()):4d} บรรทัด  (Electric only)')

# ── the tariff doPost cases travel with the module ──
case_rx = re.compile(r"\n      case 'getTariffs': \{.*?\n      \}\n\n      case 'saveTariff': \{.*?\n      \}\n", re.S)
mcase = case_rx.search(e_core)
if not mcase: sys.exit('tariff cases not found')
tariff_cases = mcase.group(0)
e_core = e_core.replace(tariff_cases, '\n{{BACKEND_CASES}}\n', 1)
(BUILD/'source/backend/modules/tariffs.cases.gs').write_text(tariff_cases.strip('\n'), encoding='utf-8')

# Water has no module cases — but core still needs the placeholder filled.
w_core = w
# Water carries a dead getLastRecord case; drop it so both cores match.
w_case_rx = re.compile(r"\n      case 'getLastRecord': \{.*?\n      \}\n", re.S)
if w_case_rx.search(w_core):
    w_core = w_case_rx.sub('\n', w_core, count=1)
    print('  dropped dead getLastRecord case from Water core')
w_core = w_core.replace("      case 'getAvailableMonths':", "{{BACKEND_CASES}}\n      case 'getAvailableMonths':", 1)

# ── per-app seeds ──
for label, src, path in [('electric', e_core, 'seeds/elec.gs'), ('water', w_core, 'seeds/water.gs')]:
    seed_parts = []
    for fn in ['initDefaultMeters', 'initDefaultReportGroups']:
        txt, src = cut_function(src, fn)
        if txt: seed_parts.append(txt)
    (BUILD/'source/backend'/path).write_text('\n\n'.join(seed_parts), encoding='utf-8')
    print(f'  {path:25s} {sum(len(p.splitlines()) for p in seed_parts):4d} บรรทัด')
    if label == 'electric': e_core = src
    else: w_core = src

# ── tokenise the config block in the Electric core, then compare cores ──
def tokenise(src):
    src = re.sub(r"const APP_ID\s*=\s*'[^']*'", "const APP_ID           = '{{APP_ID}}'", src, count=1)
    src = re.sub(r"const UNIT\s*=\s*'[^']*'", "const UNIT             = '{{UNIT}}'", src, count=1)
    src = re.sub(r"const ADMIN_SEED_PW\s*=\s*'[^']*'", "const ADMIN_SEED_PW    = '{{ADMIN_SEED_PW}}'", src, count=1)
    src = re.sub(r"const RECORDER_SEED_PW\s*=\s*'[^']*'", "const RECORDER_SEED_PW = '{{RECORDER_SEED_PW}}'", src, count=1)
    return src

e_core_t, w_core_t = tokenise(e_core), tokenise(w_core)

import difflib
el, wl = e_core_t.split('\n'), w_core_t.split('\n')
sm = difflib.SequenceMatcher(None, el, wl)
same = sum(b.size for b in sm.get_matching_blocks())
print(f'\ncore เหมือนกันหลังแยก seed/tariffs: {same}/{len(el)} = {same/len(el)*100:.0f}%')

diff = [l for l in difflib.unified_diff(wl, el, lineterm='', n=0)
        if l[:1] in '+-' and not l.startswith(('---','+++')) and l.strip(' +-')]
print(f'ยังต่างกัน {len(diff)} บรรทัด:')
for l in diff[:25]:
    print(f"   [{'E' if l[0]=='+' else 'W'}] {l[1:].strip()[:95]}")

(BUILD/'source/backend/core.gs').write_text(e_core_t, encoding='utf-8')
(BUILD/'/tmp_water_core.gs' if False else Path('/tmp/water_core.gs')).write_text(w_core_t, encoding='utf-8')
print(f'\n  backend/core.gs           {len(el):4d} บรรทัด  (จาก Electric)')
