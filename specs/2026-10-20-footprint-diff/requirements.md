# Footprint diff contents: requirements

Date: 2026-10-20. Builder testing: "What just changed: clear with
MOD signal, but not the changes themselves." The inspector names
the verdict but never shows the edit. Show the unified diff for
the selected footed file.

## Requirements

- DFR1: Selecting a footed `added`/`modified` building fetches its
  working-tree diff (`git diff HEAD`, staged + unstaged — the FR1
  baseline) and renders a Changes section: head counts `+A −R`
  plus unified hunks (`-U3`, git's own `@@`/`+`/`-` markers carry
  the structure — no green/red, DESIGN.md fences both).
- DFR2: Caps + honesty: hunks truncate at 120 lines with a visible
  `… truncated` tail; untracked-new files read `New file — full
  text below.` (the FILE section already shows the content);
  clean/removed/unavailable reads nothing (no section, never a
  guessed empty).
- DFR3: Safety mirrors open-file: contained member paths only
  (resolve + listed building + !excluded), fixed argv, secret
  masking on hunk text with a masked note, 10 s timeout,
  failures resolve to no-section (never an error lamp).
- DFR4: Freshness: re-fetch with the preview coalescing path
  (selection + patch-driven refresh of the selected building).
  Frozen previews show no section (no socket to answer).

## Non-functional

- Additive wire messages (`get-diff`/`diff`), `WIRE_VERSION` 1.
  Coverage ≥95/95 both reporters. E2E pins the modified-file
  hunks on the footprint trio fixture.
