# Zero-install preview: validation

Date: 2026-10-19. Every item must pass before the ideas item
counts as spec'd-and-shipped. Simulated vs end-to-end is
recorded per item.

## Unit (bun test, hermetic)

- V1 `preview/render.test.ts`: stylesheet link → inline style
  with the exact CSS; app script tag → inline module with the
  exact JS; all other template bytes preserved verbatim; embed
  block sets the snapshot, meta, and empty token; no launch
  token anywhere in the output; markup-bearing paths/notes
  cannot break out of the embed (output contains no literal
  script-close inside the JSON; boot covered in V8);
  byte-identical output for repeated renders; caller-supplied
  timestamp flows into meta verbatim.
- V2 script arg validation (bun test over the script's pure arg
  parser or via subprocess on tmp dirs): missing `--repo`,
  non-directory repo, non-`.html` `--out`, existing `--out`
  without `--force` → non-zero exit naming the value; `--help`
  exits 0 and documents flags + the structure-only property.
- V3 existing suites stay green unmodified; `app.ts` live boot
  unchanged (no snapshot global → current behavior, covered by
  the existing e2e).

## Integration (bun test, real server over tmp fixtures)

- V4 export round trip: run `scripts/export-preview.ts --repo
  <mini-floor copy> --out <tmp>` in-process or as a subprocess;
  assert exit 0, one-file output, the success line names path +
  bytes + buildings + belts, and the embedded snapshot parses
  to a v1 message whose building count matches the server's
  `buildingCount()` and whose belts match a `trace`-level
  ground truth (import pair in the fixture → belt present).
- V5 failure modes: export against a repo that exceeds a tiny
  `--max-files`-style ceiling fails non-zero before writing;
  unwritable `--out` dir fails non-zero naming the path. (Exact
  flag threading is implementation's choice; the property is
  fail-loud-before-partial-write.)

## Static + coverage

- V6 `bun run typecheck` clean (new files added to the
  package.json list: `preview/render.ts`,
  `preview/render.test.ts`, `scripts/export-preview.ts`, e2e
  additions).
- V7 `bash scripts/coverage-gate.sh` ≥95/95.

## Browser (e2e, headless Chromium via the committed driver)

- V8 `file://` boot: export the mini-floor fixture, open the
  file over `file://`, assert first render (diag `__floor`
  carries the frozen building count), the frozen banner names
  repo + date, the readout says "preview — frozen", dispatch is
  disabled with the stated reason, selecting a building shows
  structure rows + the no-contents line, and zero console
  errors. E2E (not simulated): real Chromium, real bundle, no
  server running.
- V9 frozen interactions: in the V8 page, run search for a
  known path, zoom across bands, toggle a zone, open the
  minimap/site-plan, and flip the Day toggle — each behaves as
  live; no WebSocket is ever constructed (assert via console
  err absence + no `ws` request possible from `file://`).
  Simulated only in the sense of scripted input; rendering is
  the real client.
- V10 version mismatch: rewrite the embed's `v` to 999 in a
  tmp copy, open it, assert the full-page mismatch message
  naming both versions and no floor render. Zero console errors
  beyond the intentional page message.

## Live trial (end-to-end, real processes + human eyes)

- V11 self-export: `bun run scripts/export-preview.ts --repo .
  --out /tmp/artifex-preview.html`, double-click the file in a
  real browser (cold load, extensions on): the "oh, I get it"
  checklist — zones read as bays, machines carry lamps, belts
  connect importers, search finds a known file, banner + frozen
  readout + disabled dispatch all visible — passes, with zero
  console errors. E2E (not simulated): the shipped artifact on
  the real repo. Optional offline re-check: disable network and
  reload; floor renders with fallback fonts.
- V12 `bun run e2e` green incl. V8–V10.

## Distribution

- V13 `preview.yml` is syntactically valid (`actionlint` if
  available in CI, else careful review) and triggers only on
  `v*` tags; README line links the release asset path. Dry-run
  where possible without cutting a tag (workflow dispatch or a
  local `act` run); the first real tag's asset is inspected by
  hand (V11 checklist on the downloaded file) before the ideas
  item is marked shipped.

## Closure

- V14 the `docs/ideas.md` "Zero-install preview" item flips to
  shipped only after V1–V13 pass; no commit/push (uncommitted
  until asked).
