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
