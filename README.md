# IMCT Consumption

Utility metering for the Isuzu Motors (Thailand) plants. Four apps —
Electric/Water × Samrong/Gateway — are generated from one shared source.

This repo holds two things:

* `index.html` — the hub page, served at `imctconsumption.github.io/IMCT_HUB/`
* everything else — the build system that produces the four apps

The apps themselves are deployed from their own repos, because GitHub Pages
maps one repo to one path and the printed QR codes point at those paths.

---

## Build

Everything runs on GitHub — nothing to install. See **[SETUP.md](SETUP.md)**
for the one-time setup, then: **Actions → Build apps → Run workflow**, pick an
app, and download the result from Artifacts.

The build does not push anywhere. You upload `index.html` to the app's repo and
paste `Code.gs` into Apps Script yourself, one app at a time — which is also
what keeps a single source edit from silently changing four live apps.

The commands below are what that workflow runs. They work locally too if you
have Node and Python, but a local install is not required.

    node tools/build.js            # all four apps
    node tools/build.js elec-sr    # just one

Output goes to `dist/<app>/` as a self-contained `index.html` plus the
`Code.gs` to paste into that app's Apps Script project.

`dist/` is gitignored — see `.gitignore` for why.

## Verify

    python3 tools/verify.py

Compares the rebuilt Samrong apps against the hand-maintained originals:
every declaration still present, none duplicated, every element id and
`onclick` handler resolvable, and the JavaScript parses. Run it after any
change to `source/`.

---

## Deploying

Step-by-step in [SETUP.md](SETUP.md). One app at a time, testing each before
moving on — deploying all four at once removes the only chance to catch a
regression on a single site.

`Code.gs` is pasted into the Apps Script editor by hand; deploy it as a **new
version of the existing deployment**, never as a new deployment — a new
deployment gets a new `/exec` URL and every QR code stops working.

Deploy `Code.gs` **before** `index.html` whenever the backend gained an
endpoint the frontend calls.

---

## Credentials

`ADMIN_SEED_PW` and `RECORDER_SEED_PW` in `config/*.json` are placeholders on
purpose. **This repo is public**, and GitHub Pages serves every file in it —
a real password committed here would be readable at a predictable URL by
anyone, with the API URL it unlocks sitting in the same file.

Set them in the Apps Script editor after pasting `Code.gs`, before the first
run. The value is only read when the `_USERS` sheet is first created; from
then on the sheet stores a hash and the constant is never consulted again.

`node tools/build.js` warns for any app still carrying a placeholder.

---

## Layout

    source/
      core/10-core-head.js     shared frontend — config, auth, entry, data, settings
      core/90-core-tail.js     shared frontend — charts, header/drawer shim
      modules/
        summary-electric.js      monthly report + zone drilldown    (Electric)
        summary-water.js         two-table month view               (Water)
        cost.js                  tariff entry + bill estimate       (Electric)
        export-exceljs.js        styled Excel export                (Electric)
      backend/
        core.gs                shared backend — byte-identical for every app
        seeds/{elec,water}.gs    initDefaultMeters, initDefaultReportGroups
        modules/tariffs.gs       _TARIFFS storage                   (Electric)
        modules/migration-elec.gs  one-off sheet rename utility     (Electric SR)
      style.css                shared verbatim
      shell-{electric,water}.html   markup, with {{STYLE}} / {{SCRIPT}} slots

    config/<app>.json          the only per-app input
    tools/build.js             assembles dist/
    tools/verify.py            checks a build against the originals

Modules are concatenated between head and tail, so they can use core helpers
and the tail's chart code can call into them. Anything core calls must live in
core, not a module — a build without that module would otherwise crash.

---

## Adding a site

Copy a config and change `APP_ID`, `APP_NS`, `SITE_CODE`, `API_URL`,
`QR_BASE_URL`, and the backend seed. No code changes.

`APP_NS` **must be unique**. All four apps share the
`imctconsumption.github.io` origin, so they share localStorage; the namespace
prefix is the only thing keeping one app's session and cache out of another's.

### Gateway

Configs exist and build cleanly, but `API_URL` is still
`PASTE_GW_APPS_SCRIPT_EXEC_URL_HERE` — create the sheet and Apps Script
deployment first, then fill it in. SETUP.md walks through it.

The Gateway seeds are intentionally empty: there is no known meter list yet,
and a guessed one would put meters on a recorder's screen that do not exist.
An admin adds them once the site is surveyed.

---

## Sheets

Each app has its own spreadsheet with its own bound Apps Script — never point
two deployments at one sheet, or their sessions and caches collide.

| Sheet | Holds |
|---|---|
| `_RECORDS` | every reading |
| `_METERS` | meter list; `valueType` decides how a reading is interpreted |
| `_REPORT_GROUPS` | consumption grouping; `type` = `main` / `util` / `monitor` |
| `_TARIFFS` | electricity rates per month per supply point (Electric only) |
| `_USERS`, `_CALENDAR`, `_AUDITLOG` | auth, working days, audit trail |

Columns are read by position. **Append new columns; never insert.** Inserting
one shifts every field after it and the app reads the wrong values silently.

After editing a sheet directly, run `flushCaches()` in the Apps Script editor —
meter and group data is cached for 12 hours and edits will not appear until it
expires otherwise.
