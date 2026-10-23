# 2026-10-20-footprint-diff — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

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

## plan.md

# Footprint diff contents: plan

## Touch list

- `server/diff.ts` (new): `readDiff(root, rel)` — `git diff HEAD
  --numstat` + `git diff HEAD -U3` via `spawnCapture` (fixed
  argv, `--` separator), 120-line hunk cap, `{ added, removed,
  hunks, truncated, untracked } | undefined`. Untracked =
  empty output while footed-added (caller passes the verdict).
- `floor-ui/wire.ts`: `get-diff` client message, `diff` server
  message (path, added, removed, hunks, truncated, masked,
  untracked).
- `server/index.ts`: `get-diff` case → `handleGetDiff`
  (open-file validation reused: contained + member + !excluded;
  label root via `rootByLabel`; mask via `maskContent`).
- `floor-ui/{index.html,app.ts,styles.css}`: Changes section
  (`#insp-diff-title` + `#insp-diff`), fetched on selection and
  with `requestPreviewSoon` for footed buildings, hidden on
  stale/deselect/empty.
- `package.json`: typecheck argv gains `server/diff.ts` +
  `server/diff.test.ts`.
- Tests: `server/diff.test.ts` (real-git: modified/untracked/
  clean/non-git/cap), server round-trip (WS `get-diff` →
  `diff`), `e2e/floor.test.ts` (trio fixture hunks for
  `src/a.ts`).

## Not in scope

Removed-file deleted-line recovery (`git show HEAD:path`),
word-diff, diff for staged-only vs unstaged splits, hunk
staging actions.

## validation.md

# Footprint diff contents: validation

- New server unit tests (modified hunks + counts, untracked flag,
  clean empty, non-git undefined, 120-line cap + truncated).
- New WS round-trip test (modified file over a real server).
- New e2e test (trio `src/a.ts` shows `-1`/`+2` hunk lines).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: MOD file inspector shows Changes `+N −M` with the
  sorting hunks; untracked file shows the new-file line.
