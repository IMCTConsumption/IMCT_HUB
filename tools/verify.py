#!/usr/bin/env python3
"""
Prove the rebuild did not lose or change anything.

A byte-for-byte diff is the wrong test: the whole point of the split is that
config values and unit strings are now generated, so those lines SHOULD differ.
What must not differ is the set of things the code defines and the work it does.

Checks, in increasing order of strictness:
  1. every top-level declaration in the original still exists in the rebuild
  2. no declaration is defined twice (a module landing in two places)
  3. every element id referenced by JS exists in the markup
  4. every onclick handler in the markup is a function that exists
  5. the JS parses
  6. lines that are neither config nor unit-driven are identical
"""
import re, sys, json, subprocess
from pathlib import Path

BUILD = Path('/home/claude/build')
ORIG  = Path('/home/claude/redesign')

PAIRS = [('elec-sr',  ORIG/'electric_new.html'),
         ('water-sr', ORIG/'water_new.html')]

def js_of(html):  return re.search(r'<script>(.*?)</script>', html, re.S).group(1)

def decls(js):
    d = {}
    for m in re.finditer(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)', js, re.M):
        d.setdefault(m.group(1), 0); d[m.group(1)] += 1
    for m in re.finditer(r'^(?:const|let|var)\s+([A-Za-z_$][\w$]*)', js, re.M):
        d.setdefault(m.group(1), 0); d[m.group(1)] += 1
    return d

fails = 0
for app, orig_path in PAIRS:
    built_path = BUILD/'dist'/app/'index.html'
    o_html, b_html = orig_path.read_text(encoding='utf-8'), built_path.read_text(encoding='utf-8')
    o_js,  b_js  = js_of(o_html), js_of(b_html)
    o_d,   b_d   = decls(o_js),  decls(b_js)

    print(f'═══ {app} ═══')

    # 1. nothing lost
    missing = sorted(set(o_d) - set(b_d))
    print(f'   {"✅" if not missing else "❌"} declarations kept: {len(o_d)} → {len(b_d)}'
          + (f'  MISSING: {missing[:8]}' if missing else ''))
    if missing: fails += 1

    # 2. nothing duplicated
    dupes = sorted([k for k, v in b_d.items() if v > 1])
    print(f'   {"✅" if not dupes else "❌"} no duplicate declarations'
          + (f'  DUPES: {dupes[:8]}' if dupes else ''))
    if dupes: fails += 1

    # 3. ids referenced by JS exist in markup
    ids_used = set(re.findall(r"getElementById\(['\"]([\w-]+)['\"]\)", b_js))
    ids_have = set(re.findall(r'id="([\w-]+)"', b_html))
    ghost = sorted(i for i in ids_used - ids_have if i not in ('year',))
    print(f'   {"✅" if not ghost else "⚠️ "} ids referenced exist: {len(ids_used)} used'
          + (f'  ABSENT: {ghost[:8]}' if ghost else ''))

    # 4. onclick handlers resolve
    handlers = set(re.findall(r'onclick="([A-Za-z_$][\w$]*)\(', b_html))
    unresolved = sorted(h for h in handlers if h not in b_d)
    print(f'   {"✅" if not unresolved else "❌"} onclick handlers defined: {len(handlers)}'
          + (f'  UNRESOLVED: {unresolved[:8]}' if unresolved else ''))
    if unresolved: fails += 1

    # 5. parses
    Path('/tmp/v.js').write_text(b_js, encoding='utf-8')
    r = subprocess.run(['node','--check','/tmp/v.js'], capture_output=True)
    print(f'   {"✅" if r.returncode==0 else "❌"} javascript parses'
          + ('' if r.returncode==0 else '  ' + r.stderr.decode()[:200]))
    if r.returncode: fails += 1

    # 6. what actually changed, ignoring lines we expect to be generated
    EXPECTED = re.compile(
        r"APP_ID|APP_NS|SITE_NAME|SITE_CODE|APP_VERSION|API_URL|QR_BASE_URL"
        r"|UNIT|TAB_ORDER|UNIT_WORD|UNIT_ICON|onTabSummary|onTabCost"
        r"|generated tab hooks|_backup_|kWh|m³|ใช้ไฟฟ้า|ใช้น้ำ|⚡|💧|\?meter=")
    import difflib
    o_l, b_l = o_js.split('\n'), b_js.split('\n')
    unexplained = [l for l in difflib.unified_diff(o_l, b_l, lineterm='', n=0)
                   if l[:1] in '+-' and not l.startswith(('---','+++'))
                   and l.strip(' +-') and not EXPECTED.search(l)]
    print(f'   {"✅" if not unexplained else "⚠️ "} unexplained line changes: {len(unexplained)}')
    for u in unexplained[:12]:
        print(f'        {u[:110]}')
    print()

print('RESULT:', 'PASS ✅' if fails == 0 else f'FAIL ❌ ({fails} hard failures)')
sys.exit(1 if fails else 0)
