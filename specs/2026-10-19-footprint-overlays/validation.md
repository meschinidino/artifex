# Change-footprint overlays: validation

Date: 2026-10-19. Run after implementation; all boxes must check
before the slice lands. Pre-landing changes go through
adversarial + structured review per repo convention.

## Manual validation

- MV1 (treatments): Boot the floor on a git scratch repo with
  one untracked file, one edited tracked file, and one
  watcher-observed deletion. Confirm brackets+`NEW`,
  bar+`MOD`, dashed+`GONE` at the right nodes, in far, mid,
  and near bands; confirm the `GONE` marker sits at the
  deleted file's old slot and its basename + `GONE` word are
  legible; confirm no treatment collides with selection,
  congestion, ghost, or pulse outlines on the same node
  (select each footed machine; force a pulse by saving it).
- MV2 (strip + toggle): Confirm the strip reads `+1 ~1 -1`
  with the accessible name intact; toggle Footprint off and
  confirm every footprint pixel vanishes (counts hidden);
  toggle back on and confirm full restore without reload.
- MV3 (commit clears): Commit everything from a terminal
  (no reload, no floor interaction). Confirm all treatments
  clear and the strip reads `+0 ~0 -0` within seconds
  (index/HEAD watch path, not the 60 s backstop — time it).
- MV4 (inspector + legend): Select each footed node and the
  `GONE` marker; confirm the `Footprint` row reads
  `added (new vs HEAD)` / `modified (differs from HEAD)` /
  `removed (deleted vs HEAD)` (+ hint on the marker), and a
  clean file reads `clean`. Confirm the legend shows all
  three new rows and matches what the floor draws.
- MV5 (honesty): Boot on a non-git directory — no treatments,
  no counts element. Boot on a git repo with `git` removed
  from PATH — same, plus a `warn:` line in the server log;
  restore `git`, touch a file, confirm footprints appear.
  `git rm` a file, then create an unrelated file that reuses
  its slot (lowest-free-wins): confirm the `GONE` marker
  drops instead of drawing under the new machine. Run an
  explicit relayout with a live marker: confirm it drops.
- MV6 (DESIGN.md eyeball): No new hue anywhere in the
  treatments (ivory/text/muted only); tags square with the
  standard geometry; no glow, no translucency, no pill
  shapes; far band still reads quiet on a dense floor.

## Technical checks

- TC1: `bun test` — full suite green (watcher, server,
  floor-ui pure modules, wire).
- TC2: `bun run typecheck` — strict `tsc --noEmit` clean.
- TC3: `bun run e2e` — browser suite green incl. the new
  git-fixture tests (treatments ↔ `__footprint` /
  `footRendered`, commit-clears, toggle, non-git-hide);
  zero console errors after every test (existing harness
  rule).
- TC4: Coverage gate holds — raw Bun function/line indicators
  ≥95 on both reporters (`scripts/coverage-gate.sh` as in
  CI); branch coverage recorded in the PR notes, not gated.
- TC5: No hardcoded hex in new UI code (`grep` new styles/DOM
  for `#[0-9a-f]` outside token definitions); no new hues;
  `WIRE_VERSION` still 1 (asserted by a test).
- TC6: Status-spawn probe — save a file 20 times in 5 s on a
  git floor and confirm (server log counter or timing) that
  `git status` ran at most ~3 times (debounce holds) and no
  flush awaited it (keystroke-to-patch latency unchanged
  vs pre-slice on the same repo).

## Expected unit / integration tests

- `watcher/gitstatus.test.ts`: XY-table fixtures (untracked,
  staged-new, unstaged/staged modify, both deletes, `AD`
  net-zero, renames with NUL pairs incl. `R→modified` on the
  new path, collapsed untracked dirs, unmerged exist/gone,
  typechange, ignored/unknown codes → none); spawn failure /
  non-zero exit / timeout → unavailable; `--untracked-files`
  + config-hardening argv asserted.
- `server/server.test.ts` (or status-lifecycle tests): boot
  stamps snapshot when fast / patch-follows when slow;
  foot-change-only diffing (unchanged buildings not
  upserted); tombstone create → drop on status-clear,
  slot-reuse, and relayout; disk-truth-wins (live building
  + removed status → no mark); non-git labels contribute
  nothing; per-label aggregation; gitdir-file resolution +
  fallback.
- `floor-ui/wire.test.ts`: `removed`/`removedMarks` snapshot
  + patch apply (incl. gap resync carrying marks);
  `isCountsOnlyChange` true for foot-only, false when any
  other field moves.
- `floor-ui/machines.test.ts` (or where the pure helpers
  live): footprint inspector-row strings (all four states);
  footprint tag anchor math (stacks below ERR, clears the
  near-band line row); `+A ~M -R` count formatting incl.
  `(+N more unplotted)` overflow.
- `e2e/floor.test.ts` (git fixture): treatments ↔
  `__footprint` agreement in three bands; commit-clears
  without reload; toggle off → `footRendered` zeros with
  state intact; non-git floor hides counts; zero console
  errors throughout.

## Closure criteria

- All MV/TC boxes checked with evidence (screenshots of the
  three treatments, commit-clears timing, debounce numbers,
  gate numbers) quoted in the landing PR.
- New tests carry `Value:` comments per repo convention;
  residuals (if any) named in `docs/coverage-reaudit.md`.
- Adversarial + structured review passes recorded; review
  fixes stay uncommitted until the user says otherwise.
- `docs/ideas.md` item marked as specified/shipped (link this
  spec dir); roadmap/TODOS updated only if the builder moves
  the item into scheduled work.
