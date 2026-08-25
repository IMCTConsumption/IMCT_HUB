# One-off migration tools

These ran once, to carve the two hand-maintained `index.html` / `Code.gs` files
into the shared source in this repo. They are kept for provenance — they show
exactly how the split was derived — but they are not part of the build and
should not be run again: they read from paths that no longer exist and would
overwrite `source/` with output from stale inputs.

The tools you actually use day to day are `../build.js` and `../verify.py`.
