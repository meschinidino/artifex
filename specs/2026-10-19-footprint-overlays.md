# 2026-10-19-footprint-overlays — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Change-footprint overlays: requirements

Date: 2026-10-19. Implements `docs/ideas.md` "Change-footprint
overlays", working-tree slice only. Design authority: the ideas
item (added / modified / removed each distinct, blast radius at a
glance), `DESIGN.md` (no new hues; shape + label, never color-only;
square Operate chrome; existing tokens), D4 one-meaning encodings,
and text-is-truth (no git → no treatments, never fake clean).

## Functional requirements

### Status source

- FR1: The footprint baseline is HEAD: a path counts as
  footed when the index or the worktree differs from HEAD.
  Porcelain XY → verdict table (X = index, Y = worktree):
  `??` → added; X=`A` with Y≠`D` → added; `AD` → none (net
  zero vs HEAD); Y=`D` with X≠`A`, or X=`D` → removed;
  `R`/`C` in either column → modified on the *new* path (the
  old path gets no tombstone — a rename is continuity, and
  the floor already renames the building); unmerged
  (`U` in either column, `AA`, `DD`) → modified when the
  file exists on disk, removed when it does not; any other
  `M`/`T` in either column → modified; `!!` and unknown
  codes → none (fail closed, no treatment). Rename entries
  consume the second NUL field; collapsed untracked-dir
  entries (`path/`) expand against the listing (every listed
  path under the prefix → added).
- FR2: Status runs `git -c core.fsmonitor= -c
  core.untrackedCache=false status --porcelain=v1 -z
  --untracked-files=normal` per repo root (per label root on
  federated floors), via async spawn: flushes and boot never
  wait for it. Timeout 10 s live / 2 s at boot; timeout,
  non-zero exit, or unspawnable git → status unavailable
  for that label (retried on the next trigger, never cached
  as clean). Only floor members are stamped (intersect with
  the listing).
- FR3: Re-read triggers per git-backed label: (a) every
  applied watcher flush, debounced to at most one run per
  2 s with a trailing dirty re-run; (b) dedicated
  non-recursive watches on `<gitdir>/index` and
  `<gitdir>/HEAD` (commit/stage/checkout/branch-switch),
  debounced like (a); (c) the 60 s backstop rescan.
  `<repo>/.git` as a file resolves via its `gitdir:`
  pointer; unresolvable → (a) + (c) only. Labels without
  `.git` are never queried.

### Wire + server state

- FR4: `Building.foot?: "added" | "modified"` (absent =
  clean or status unavailable). `RemovedMark = { path,
  zoneId, x, y, band }`. `SnapshotMessage.removed:
  RemovedMark[]`; `PatchMessage.removedMarks?:
  RemovedMark[]` (full replacement when changed).
  `ClientFloorState.removed: Map<path, RemovedMark>`,
  maintained by `applySnapshot`/`applyPatch`.
  `WIRE_VERSION` stays 1.
- FR5: The server diffs each status re-read path-by-path and
  upserts only buildings whose `foot` changed, through the
  existing pending-patch machinery (ordinary `stateVersion`
  increments). Boot does not block on git: stamps that land
  in time join the first snapshot, late ones follow as a
  patch.
- FR6: Tombstone lifecycle. On a watcher `deleted` for a path
  whose status is (or becomes) `removed`, the server captures
  the placement from `layout.buildings[path]` *before*
  removal and emits a `RemovedMark`. A mark drops when any
  of: status no longer says removed; a live building takes
  the slot (`zoneId`+`x`+`y`); an explicit relayout runs.
  Marks are never persisted: deletions not observed live
  this boot get no marker (the `-R` count still covers
  them). A path with a live building never carries a mark
  (disk truth wins over status contradictions).

### Floor treatments

- FR7: Added buildings (all bands): 4 ivory L-corner brackets
  outside the machine body (2 px strokes, ~8 px legs) plus a
  `NEW` tag under the machine — ERR-tag geometry (Saira 600
  in an ivory outline rect), stacked below the ERR tag when
  both show, clearing the near-band line-count row like ERR
  does. Binary crates get brackets + tag too (no lamp
  language is touched).
- FR8: Modified buildings (all bands): a 4 px solid ivory
  footing bar under the machine's bottom edge (full width +
  2 px overhang per side) plus a `MOD` tag below the bar,
  same tag language and stacking as FR7.
- FR9: Removed marks (all bands): a flat dashed-ivory outline
  rect at the tombstone slot, machine-sized by band with the
  standard slot inset — ghost geometry in ivory instead of
  amber, with no shadow, no fill, and no lamp — plus the
  Saira basename and a mono `GONE` word beneath (ivory, vs
  the ghost's amber state word). At most 200 marks drawn in
  path order; overflow appends `(+N more unplotted)` to the
  strip counts (FR11).
- FR10: Removed marks are clickable and keyboard-reachable
  like machines: selecting one shows a minimal inspector
  (path, zone, `Footprint: removed (deleted vs HEAD)`, and
  the hint `Restore the file or commit to clear`). Clicking
  empty floor / pressing Escape clears it like a machine
  selection.
- FR11: Top strip: a `Footprint` toggle button (aria-pressed,
  default on, session-only) and a mono `#foot-counts`
  readout `+A ~M -R` with accessible name `footprint: A
  added, M modified, R removed`. Off-toggle or no label
  with status → readout hidden (hidden = unknown, never
  clean). Fresh empty status → `+0 ~0 -0` (verified clean).
  Counts aggregate available labels only. Toggle-off skips
  all footprint drawing (treatments, marks, tags).
- FR12: Non-git floors (walk fallback, no `.git` on any
  label) and total status failure: no treatments, no marks,
  counts hidden. No mtime heuristic stands in for git.
- FR13: A foot-only upsert (same building, only `foot`
  changed) skips the change pulse, the last-change readout,
  and the preview re-request (the file did not change, only
  its HEAD-relative status), while the inspector refreshes
  when the upserted building is selected.
  (`isCountsOnlyChange` covers `foot`.)
- FR14: Inspector `Footprint` row for selected buildings via
  `inspectorRows`: `added (new vs HEAD)` / `modified
  (differs from HEAD)` / `clean` / `unknown (git status
  unavailable)`. `clean` renders only when the label has
  fresh status and the path is unfooted; otherwise
  `unknown`.
- FR15: Legend gains three rows in the existing swatch style:
  corner brackets → `added — NEW`; footing bar → `modified
  — MOD`; dashed outline → `removed — GONE`.
- FR16: Treatments use existing tokens only (ivory/text,
  muted, well for tag grounds where needed): no new hues,
  no hardcoded hex in new UI code, square tags, standard
  focus ring where focusable. Every treatment pairs shape +
  label (D4) and never reuses the selection (−3 full rect),
  congestion (−5/−9 double rule), ghost (dashed amber), or
  pulse (green ring) languages.

### Diag hooks

- FR17: `window.__footprint = { added, modified, removed,
  available }` reflects wire state (counts of footed
  buildings + marks; `available` = ≥1 label with status).
  `__floor` gains `footRendered: { added, modified, removed
  }` counting marks actually drawn (post-toggle, post-cap).
  E2E asserts state→rendered correspondence through these.

## Non-functional requirements

- NFR1: No new process, port, or production dependency (D14;
  one Bun process, 150 MiB budget). `git status` runs as a
  short-lived child like the parser subprocess.
- NFR2: Status work stays off interactive paths: async spawn,
  ≤0.5 Hz per label outside membership events, never on
  keystrokes directly (flush debounce applies first), no
  per-frame work (treatments draw from wire state like all
  machine dressing).
- NFR3: Honesty: unknown codes → no treatment (FR1),
  unavailable status → hidden counts (FR11–FR12), render-cap
  overflow named (FR9), disk truth wins contradictions
  (FR6), tombstones dropped on slot reuse rather than drawn
  under a new machine (FR6).
- NFR4: Safety: status output is untrusted repo content —
  paths render via the existing path pipelines only
  (`textContent`, canvas fillText with the standard fonts);
  the git spawn carries the `scan.ts` config hardening
  (FR2) and never writes (no `gc`, no helpers, read-only
  argv).
- NFR5: Coverage stays ≥95 raw function/line on both Bun
  reporters (CI gate); branch coverage recorded, not gated.
  New canvas code follows the existing e2e-via-diag pattern.
- NFR6: `WIRE_VERSION` stays 1 (additive wire changes, both
  sides ship together).

## Acceptance criteria

- AC1: On a git fixture repo with an untracked file, an
  edited tracked file, and a deleted tracked file, the floor
  shows brackets+`NEW`, bar+`MOD`, and dashed+`GONE` at the
  right nodes in all three zoom bands, the strip reads
  `+1 ~1 -1`, and `__footprint` agrees.
- AC2: Committing everything clears all treatments and the
  strip reads `+0 ~0 -0` without a reload (index/HEAD watch
  path); `git rm`-ing a file then touching an unrelated file
  keeps the `GONE` marker until commit or slot reuse.
- AC3: A non-git fixture floor shows no treatments and no
  counts element; killing `git` (PATH without git) on a git
  fixture degrades to the same with a `warn:` log, and
  restores on the next trigger when git returns.
- AC4: Toggle-off hides every footprint pixel
  (`footRendered` zeros while `__footprint` keeps state);
  toggle is session-only and defaults on; legend documents
  all three treatments.
- AC5: `bun test`, `bun run typecheck`, `bun run e2e` green;
  coverage gate holds; no new hues / hardcoded hex in new
  UI code.

## plan.md

# Change-footprint overlays: plan

Date: 2026-10-19. Specs `docs/ideas.md` "Change-footprint overlays"
as a small complete slice: git working-tree status → per-node
treatment on the floor, so one uncommitted change shows its
architectural blast radius at a glance.

## Objective

Render the working tree's footprint directly on the floor: added,
modified, and removed nodes each get their own distinct treatment,
plus a top-strip `+A ~M -R` summary. Overlay treatments use shape +
label only (no new hues per `DESIGN.md`), nest with the existing
selection / congestion / ghost / pulse outlines without collision,
and stay truthful: no git means no treatments (never a fake clean),
stale states are impossible by construction (status re-reads on
every trigger that can change it).

## Scope

In scope:

- New pure-ish module `watcher/gitstatus.ts`: async
  `git status --porcelain=v1 -z` per repo root, same spawn
  hardening as `watcher/scan.ts`, pure porcelain parser with
  fixture tests.
- Server: per-label status lifecycle (boot read, re-read on
  watcher flushes + `.git/index`/`HEAD` watches + 60 s backstop),
  `foot` stamping on buildings, tombstones for live-observed
  deletions, wire additions (`Building.foot`, `RemovedMark`,
  snapshot/patch fields).
- Client: per-node treatments in all zoom bands, `GONE` markers,
  top-strip toggle + counts, inspector footprint row, legend rows,
  `__footprint` / `__floor.footRendered` diag hooks.
- Unit + integration + e2e tests; coverage stays ≥95 raw.

Out of scope:

- Session footprints (what one run touched): the ideas item names
  this as later work on the same machinery. The wire reserves the
  shape for it (`foot` stays working-tree-only; a later slice
  adds a separate per-session marks array). No session/run
  coupling in this slice.
- Minimap tinting, belt recoloring, zone-level rollups: nodes +
  strip counts only.
- Agent-interface exposure (`floor.getFootprint` or similar):
  the ideas item is floor-visual; queries can follow.
- Persisted tombstones: removed markers exist only for deletions
  observed live this boot (see Decision 4).
- Staged-vs-unstaged distinction in the UI: the baseline is HEAD,
  index + worktree count together as "the change" (Decision 1).
- Non-git floors (walk fallback): no treatments, counts hidden
  (FR12). No mtime-heuristic fallback — that would be guessing.

## Proposed architecture

### Status source (`watcher/gitstatus.ts`)

- `readGitStatus(repoRoot): Promise<Map<string, FootXY>>` spawns
  `git -c core.fsmonitor= -c core.untrackedCache=false status
  --porcelain=v1 -z --untracked-files=normal` (flag hardening
  copied from `listViaGit`: the opened repo is untrusted input).
  Async `Bun.spawn` — never blocks a watcher flush. Timeout 10 s
  live / 2 s at boot; timeout or non-zero exit or unspawnable
  git → `undefined` (unavailable, not clean).
- Pure `parsePorcelainZ(bytes): ParsedStatus` maps XY codes to
  `added | modified | removed | none` per the FR1 table, consuming
  the second NUL field of rename entries (`R  new\0old`) and
  expanding collapsed untracked-dir entries (`path/`) against the
  listing. `-z` output is raw bytes: no C-quoting to unescape.
- Only floor members are stamped: status paths intersect the
  listing (hard-excluded paths can never carry a treatment).

### Server lifecycle

- One status state per repo label (federated floors: per label
  root; labels without `.git` contribute nothing). Boot reads
  all labels concurrently with the initial parse pass; results
  that land in time stamp the first snapshot, late ones arrive
  as an ordinary patch (no special versioning).
- Re-read triggers: (a) every applied watcher flush, debounced
  to at most one status run per 2 s per label with a trailing
  dirty flag; (b) dedicated non-recursive watches on
  `<gitdir>/index` and `<gitdir>/HEAD` (external commit / stage /
  checkout / branch switch touch no tracked file, so the tree
  watcher cannot see them); (c) the 60 s backstop rescan.
  Gitdir resolution: `<repo>/.git` dir, else the `gitdir:`
  pointer when `.git` is a file (worktrees); unresolvable →
  triggers (a) + (c) only.
- Stamp: `toBuilding` gains `foot` from the label's status map.
  A status re-read diffs path-by-path against the last map and
  upserts only buildings whose `foot` changed, folded into the
  existing pending-patch machinery.
- Tombstones: on a watcher `deleted` for a path whose status is
  (or becomes) `removed`, the server captures the placement from
  `layout.buildings[path]` *before* `removeBuilding` and keeps
  `{path, zoneId, x, y, band}` while (i) status still says
  removed, (ii) no live building occupies the slot
  (`zoneId`+`x`+`y`), (iii) no relayout has run since. Dropped
  otherwise. Never persisted (per-boot, like the runs ledger).

### Wire (`floor-ui/wire.ts`, additive, `WIRE_VERSION` stays 1)

- `Building.foot?: "added" | "modified"` (absent = clean or
  status unavailable — the client cannot tell and does not
  need to; the strip counts carry availability).
- `RemovedMark = { path, zoneId, x, y, band }` (slot origin
  like `GhostBuilding`, machine-sized by band).
- `SnapshotMessage.removed: RemovedMark[]`;
  `PatchMessage.removedMarks?: RemovedMark[]` (full replacement
  when changed — the ghosts precedent).
- `ClientFloorState.removed: Map<path, RemovedMark>`;
  `applySnapshot`/`applyPatch` handle it (patch order follows
  the ghost block).
- `isCountsOnlyChange` also ignores `foot`: a foot-only upsert
  skips the change pulse, the last-change readout, and the
  preview re-request (the file did not change, only its
  HEAD-relative status did), while the inspector still refreshes
  when the upserted building is selected.

### Client render (`floor-ui/`)

All bands (the ERR-tag precedent: footprint is the point, it
does not hide at far zoom). Ivory/text/muted only — no new
hues; every treatment pairs shape + label (D4).

- Added: 4 ivory L-corner brackets outside the machine body +
  `NEW` tag under the machine (ERR-tag geometry, ivory).
- Modified: 4 px solid ivory footing bar under the machine's
  bottom edge ("fresh weld bead") + `MOD` tag below the bar.
- Removed: flat dashed-ivory outline rect at the tombstone slot
  (ghost geometry, ivory not amber; no shadow, no fill, no
  lamp) + Saira basename + mono `GONE` word beneath.
- Nesting: brackets (corners) and bar (below) never collide
  with the selection (−3 full rect + above-machine tag) or
  congestion (−5/−9 double rule) outlines. Footprint tags stack
  below the ERR tag row when both show. Removed markers have no
  machine, so no outline can collide with them.
- Top strip: `Footprint` toggle button (aria-pressed, default
  on, session-only — the Follow/Inspector precedent) and a
  mono `#foot-counts` readout `+A ~M -R` with an accessible
  name; hidden when the toggle is off or no label has status.
  Zeros show when status is fresh and empty (verified clean);
  hidden means unknown, never clean.
- Inspector: a `Footprint` definition row (`added (new vs
  HEAD)` / `modified (differs from HEAD)` / `clean` /
  `unknown (git status unavailable)`), via extended
  `inspectorRows`. Removed markers are clickable and show a
  minimal inspector (path, zone, footprint, restore-or-commit
  hint).
- Legend: three rows (brackets → added/NEW, bar → modified/MOD,
  dashed outline → removed/GONE) in the existing swatch style.
- Diag: `window.__footprint = { added, modified, removed,
  available }` (wire state) and `__floor.footRendered`
  (marks actually drawn, post-toggle and post-cap) for e2e.
- Render cap: at most 200 removed markers drawn (path order);
  overflow appends `(+N more unplotted)` to the strip counts —
  visible and truthful, never silent.

## Steps

1. `watcher/gitstatus.ts` + `watcher/gitstatus.test.ts`: parser
   table (FR1) incl. renames, collapsed dirs, unmerged, `AD`
   net-zero; spawn wrapper with timeout/failure tests (each
   `Value:`-commented per convention).
2. Server: status lifecycle + gitdir/index watches + `foot`
   stamping + tombstones + wire fields; `server/server.test.ts`
   lifecycle tests (tombstone create/drop/slot-reuse/relayout,
   non-git labels, status-failure availability).
3. Wire: `RemovedMark`, snapshot/patch fields, client-state
   apply, `isCountsOnlyChange` extension; `floor-ui/wire.test.ts`.
4. Client: treatments + tags + toggle + counts + inspector row
   + legend + diag hooks; pure helpers in `machines.ts` where
   testable without canvas (tag anchors, footprint row
   strings); `machines.test.ts`.
5. E2E over a git fixture repo (added/modified/removed +
   commit-clears + toggle + non-git-hide); then validation per
   `validation.md`; adversarial + structured review before
   landing (repo convention).

## Risks

- `git status` latency on huge repos: bounded by the 2 s
  debounce, async spawn (flushes never wait), and the 10 s
  timeout; a slow repo degrades to briefly stale footprints,
  never a stuck floor.
- Porcelain format drift: v1 has been stable for years; the
  parser fails closed on unknown codes (no treatment) and the
  table is pinned by fixtures.
- External git ops (commit in a terminal): invisible to the
  tree watcher — covered by the index/HEAD watches plus the
  60 s backstop; worst case is a stale-till-backstop overlay,
  and the commit-clears path is e2e-asserted.
- Far-band noise: three new treatments in every band could
  clutter dense floors. Mitigated by minimal geometry
  (corners/bar/dashes + one small tag) and the toggle; the
  comprehension-gate style of eyeball check in MV1 covers it.
- Coverage gate: new server branches (gitdir fallback, timeout,
  tombstone drops) and the parser need direct tests; canvas
  drawing stays in the existing e2e-via-diag pattern.

## Decisions

1. **Baseline is HEAD; index + worktree count together.**
   Alternatives (worktree-vs-index, index-vs-HEAD) split one
   change into two footprints and need two treatments per node.
   "The change" is everything uncommitted; staged-new is still
   added, staged fixes are still modified.
2. **Treatments extend shape + label, never hue.** Green owns
   the live worker / change pulse, amber owns planned ghosts,
   red owns errors — all fenced by `DESIGN.md`. Footprint gets
   ivory corners (added), an ivory footing bar (modified), and
   a dashed ivory ghost-geometry marker (removed), each with a
   `NEW`/`MOD`/`GONE` label. No outline-offset collisions with
   selection (−3) or congestion (−5/−9) by construction.
3. **Non-blocking status, patch-follows.** The floor never waits
   for git: boot and flushes proceed, footprint arrives as an
   ordinary patch. Ordering guarantee is just the existing
   `stateVersion` chain — no new protocol machinery.
4. **Tombstones are live-observed and per-boot.** A deletion the
   server did not watch happen (pre-boot, or while down) has no
   last-known slot in this boot's layout, so it gets no marker —
   only the `-R` count. Persisting tombstones in the layout save
   is explicit future work, not silent scope.
5. **No staged/unstaged split in v1.** The XY table collapses
   both columns to one verdict per path. If users ask which half
   a mark lives in, the inspector row is the place — not a
   second treatment.

## Assumptions (flagged per delegation)

- A1: `git` is available where the server runs when floors are
  git repos; absence degrades to no-footprint (FR12), tested.
- A2: porcelain v1 `-z` field layout (rename `new\0old` pairs,
  collapsed-dir trailing slash) matches git ≥2.7 behavior;
   pinned by fixtures, fails closed on surprises.
- A3: `.git/index` + `.git/HEAD` mtime/creation traffic fires
  the platform `fs.watch` for commit/stage/checkout/branch
  operations on the dev Mac (Linux/macOS FSEvents/kqueue
  cover this; a platform that coalesces them away still
  converges via the 60 s backstop).
- A4: the 2 s status debounce keeps `git status` off the
  keystroke path without perceptible staleness; tunable in one
  constant if potato-gate measurements disagree.
- A5: machine geometry (`BAND_SIZES`, `PITCH`, tag rows) and the
  top-strip/legend/inspector DOM ids named here match the
  parent checkout at implementation time; small drifts adapt
  without changing the FR contracts.

## validation.md

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
