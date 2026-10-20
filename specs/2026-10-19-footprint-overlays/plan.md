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
