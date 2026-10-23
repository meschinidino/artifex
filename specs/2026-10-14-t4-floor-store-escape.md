# 2026-10-14-t4-floor-store-escape — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# T4 — Floor store + 1,000-block escape hatch: requirements

Date: 2026-10-14. Implements roadmap T4 (P1) and TODOS.md "Floor
escape for the 1,000-block cap". Design authority: D12 (access and
zoom), D10 (1,000 cap with N of M), D13 (layout stability — jump
never moves buildings).

## Functional requirements

### Search and jump (client)

- FR1: A search box in the top strip filters the client's full
  building set by repo-relative path substring, case-insensitive,
  as the user types.
- FR2: Results render as a DOM listbox showing at most 50 matches
  with a truthful total ("50 of 132"). Empty query shows no list;
  no match shows an explicit "no matches" row (never a silent
  empty box).
- FR3: Basename matches rank above path-only matches; ties order by
  path. Ranking is deterministic for a given building set.
- FR4: The list is keyboard-navigable: ArrowUp/ArrowDown move the
  active result, Enter jumps, Escape closes and returns focus to the
  input. Mouse click on a result jumps identically.
- FR5: Jump expands the result's zone, centers the camera on the
  machine at near-band scale (label legible), and selects it through
  the existing selection path (inspector as DOM text + file preview
  request).
- FR6: The selected building always renders when its zone is
  expanded, even past the 1,000-block cut (jump expands the zone
  first). A collapsed zone never shows a lone machine — its caption
  already covers the hidden set. No other cap behavior changes.
- FR7: A capped expanded zone shows a truthful hint on its pad:
  "+N hidden — search to find". Collapsed zones keep their current
  "N machines — click pad to expand" caption.
- FR8: `window.__search` exposes `{ query, matches, shown,
  selected }` for browser probes.

### Floor store (server)

- FR9: Every event accepted by `emitEvent` is appended to
  `.artifex/event-log.jsonl` (one JSON object per line), best
  effort: a write failure warns and the floor keeps serving.
- FR10: On boot the server loads the persisted log (last 1,000 valid
  events, oldest first) before the watcher starts emitting, so
  `floor.eventLog` continues across restarts.
- FR11: Corrupt lines (bad JSON or validator rejection) are skipped
  with a warning; they never abort the load and never wipe valid
  history.
- FR12: The log file is bounded: past 2,000 lines it compacts to the
  last 1,000 valid events via atomic tmp+rename. Loads refuse files
  over 8 MiB (empty log + warning).
- FR13: The store treats the repo as untrusted input, matching the
  layout persistence: no writes through a planted `.artifex`
  symlink; no unbounded reads; failures warn, never crash boot.

## Non-functional requirements

- NFR1: No wire protocol change (WIRE_VERSION stays 1); no new
  production dependencies; Bun + strict TypeScript throughout.
- NFR2: The render cap stays 1,000 blocks per frame plus at most one
  exempted selection. Search runs on input events and on snapshot /
  patch arrival while the list is open (never polled, never per
  frame); results list caps at 50 DOM rows. Per-frame additions stay
  linear and unmeasured-hot: one selection lookup plus capped-zone
  hint plates (drive mode holds 60fps on the 1,101-file fixture).
- NFR3: Tokens-only styling for new UI (no hardcoded hex); new UI
  text follows the existing voice; states never color-only.
- NFR4: Potato budgets unchanged: server + tab behavior from T3a/T3b
  must not regress (no new always-on polling; event append is
  O(line) sync I/O at watcher-event rate).
- NFR5: Reduced-motion and idle-render rules hold: search/jump
  triggers at most the normal render-on-demand frames.

## Content / data requirements

- The persisted log keeps validated `FloorEvent` objects only
  (EVENTS_VERSION 1); each line is the exact object the in-memory
  log holds.
- Search matches on `Building.path` only (repo-relative POSIX
  paths); no content search.

## Acceptance criteria

- AC1: On a fixture zone with >1,000 files, typing a capped file's
  name finds it, Enter centers it with its label drawn, and the
  inspector shows its real metadata.
- AC2: The status strip still reads "N of M machines" with N ≤ 1,001
  and M the true total; capped pads show the "+N hidden" hint.
- AC3: Restarting the server against the same repo restores the
  event log (same tail event ids, same length up to the 1,000 cap).
- AC4: A hand-corrupted log line is skipped on boot with a warning;
  valid neighbors load.
- AC5: `bun test` and `bun run typecheck` pass; new behavior has
  regression tests (search, visible-cap exemption, store
  round-trip/corruption/compaction).

## plan.md

# T4 — Floor store + 1,000-block escape hatch: plan

Date: 2026-10-14. Roadmap milestone "Next: make the floor honest",
first item. Status: implemented and validated 2026-10-14 (137 tests
green, typecheck clean, browser probe 12/12, drive holds 60fps).

## Objective

Close the two honesty gaps the 2026-10-13 review flagged on the
shipped T3a/T3b floor:

1. Files past the 1,000-block render cut are invisible and
   unclickable — the design accepts the cap only because a
   search/zoom-to-file escape exists (D12), and T3a shipped the cap
   without it.
2. The event log is memory-only: a restart wipes the floor's history,
   which the ghost layer and intent binding will need as durable
   state.

## Scope

In scope:

- Search-and-jump by path in the floor UI (design D12): a top-strip
  search box, a keyboard-navigable results list, and jump-to-file
  (expand zone, center camera, select the machine).
- Cap exemption for the selected building: a jumped-to machine
  renders even when its zone exceeds the cut, so every machine is
  reachable.
- Truthful capped-zone indication: a capped pad says how many
  machines are hidden and points at search.
- Persisted event log: append-only `.artifex/event-log.jsonl` in the
  repo, loaded on boot, bounded and compacted, with the same
  untrusted-input hardening as the existing layout persistence.
- Unit/integration tests for all new behavior; existing suites stay
  green.

Out of scope:

- Arrow-key traversal across the floor canvas (D12 remainder beyond
  the results list), minimap interaction changes.
- Ghost layer, intent binding at ingest (next roadmap milestone;
  this slice only makes the log it will read durable).
- Any wire protocol change (WIRE_VERSION stays 1): the client already
  receives every building in the snapshot, so search needs no new
  server round trip.
- Exposing events to the browser client; the log stays server-side.
- Layout compaction, membership policy, scale ceilings, DESIGN.md.

## Proposed architecture

### Escape hatch (client only)

- New pure module `floor-ui/search.ts`: `searchBuildings(buildings,
  query, limit)` over the client's full building map.
  Case-insensitive substring on the repo-relative path; basename
  matches rank above path matches; ties by path order. Returns the
  shown matches plus the total match count (the list caps at 50 so
  the DOM stays small; the count stays truthful).
- `index.html`: a search input in the top strip plus a results
  listbox (DOM, `role="listbox"`, arrow keys + Enter + Escape).
  Selecting a result jumps: the target zone expands, the camera
  centers on the machine at near-band scale so its label draws, and
  the existing select path runs (inspector + preview).
- Move `computeVisible` and `MAX_BLOCKS` from `app.ts` into a new
  pure module `floor-ui/visible.ts` (app.ts is DOM-entangled and
  untestable). `computeVisible` gains one rule: the selected building
  is always in the rendered set, even past the cut. It also reports
  per-zone hidden counts so capped pads can render "+N hidden —
  search to find".
- Styles in `styles.css` from CSS tokens only (no hardcoded hex).
- Diag hook `window.__search = { query, matches, shown, selected }`
  as a supported probe surface alongside `__floor` / `__belts`.

### Floor store (server only)

- New module `server/store.ts` owning the event log half of the
  `.artifex/` store (layout persistence in `server/index.ts` is
  unchanged — it already shipped in T3a):
  - `loadEventLog(repo, max)`: reads `.artifex/event-log.jsonl`,
    re-validates every line with `validateFloorEvent`, skips corrupt
    lines with a warning (append-only history is never nuked for one
    bad line), keeps the last `max` (1,000) valid events. Bounded
    read (8 MiB, same as layout state); oversize or unreadable file
    yields an empty log with a warning.
  - `appendEvent(repo, event)`: appends one JSON line, best-effort
    (warn on failure, never throw — a read-only repo must still
    serve the floor). Refuses to write through a planted `.artifex`
    symlink, mirroring `persistLayout`.
  - `maybeCompactEventLog(repo, max)`: when the file exceeds
    2×max lines, rewrites the last max valid lines via atomic
    tmp+rename.
- `createFloorServer` loads the log at boot (before the watcher
  starts emitting) and appends from `emitEvent`. The in-memory cap
  (EVENT_LOG_MAX) stays as the live bound.

## Implementation steps

1. `floor-ui/search.ts` + `floor-ui/search.test.ts` (match, rank,
   limit, empty query, case-insensitivity).
2. `floor-ui/visible.ts` (moved `computeVisible` + selection
   exemption + hidden counts) + `floor-ui/visible.test.ts`,
   including a past-the-cut selection regression test.
3. `index.html` search box + results listbox; `app.ts` wiring
   (jump, capped-pad hint, `__search` hook); `styles.css` tokens.
4. `server/store.ts` + `server/store.test.ts` (round trip, corrupt
   line skip, oversize guard, compaction, symlink refusal); wire
   load/append into `server/index.ts`.
5. Run `bun test` + `bun run typecheck`; manual floor check on a
   fixture with a >1,000-file zone (search reaches a capped file;
   restart preserves the event log).
6. Update README status line and `specs/roadmap.md` (T4 done).

## Risks / decisions

- Snapshot already ships all buildings, so client-side search adds
  no server load and no protocol risk. If a future scale ceiling
  pages the snapshot, search must move server-side — noted, not
  built.
- Selection exemption renders at most one extra machine past the
  1,000 cut; the perf cap is effectively unchanged.
- Event-log append is synchronous per event; watcher event volume is
  low (debounced batches) and lines are small, so no batching
  complexity is warranted in v1.
- D12's arrow-key floor traversal stays out: results-list keys are
  the escape; full canvas traversal is its own slice.

## Expected result

Any machine on the floor is reachable by typing part of its path,
capped pads say so honestly, and the floor's event history survives
a restart — the two P1 blockers to the single-repo validation gate.

## validation.md

# T4 — Floor store + 1,000-block escape hatch: validation

Date: 2026-10-14. Run after implementation; all boxes must check
before the roadmap marks T4 done.

## Manual validation

- MV1 (escape): Boot the floor on a fixture repo with one zone of
  >1,000 files. Confirm the status strip reads "1000 of M machines"
  and the pad shows "+N hidden — search to find".
- MV2 (jump): Type a capped file's basename in search, press Enter.
  Confirm the camera centers on the machine, its label draws, and
  the inspector shows its true lines/bytes/parse state.
- MV3 (results): Type a query matching >50 files; confirm the list
  shows 50 rows with a truthful "50 of N" count. Type a query with
  no match; confirm the explicit "no matches" row.
- MV4 (keys): ArrowDown/ArrowUp move through results, Enter jumps,
  Escape closes the list and keeps focus in the input.
- MV5 (store): With the floor running, touch a file (one watcher
  event), stop the server, restart on the same repo, and confirm the
  event log still contains the pre-restart tail (compare via a
  scratch probe of `floor.eventLog`, not by editing the UI).
- MV6 (corruption): Append a garbage line to
  `.artifex/event-log.jsonl`, restart, confirm boot warns and valid
  history still loads.

## Technical checks

- TC1: `bun test` — full suite green (events, layout, parser,
  watcher, server, search, visible, store).
- TC2: `bun run typecheck` — strict `tsc --noEmit` clean.
- TC3: `?drive=1` frame probes on the mega-zone fixture show no
  regression vs the T3b numbers (search adds no per-frame work).
- TC4: No hardcoded hex in new UI code (`grep` styles + search DOM
  for `#[0-9a-f]` outside token definitions).

## Expected unit / integration tests

- `floor-ui/search.test.ts`: substring + case-insensitivity, basename
  ranking, 50-row cap with truthful total, empty query, no-match,
  deterministic order.
- `floor-ui/visible.test.ts`: 1,000-block cut unchanged without a
  selection; selected building past the cut renders (+1 over cap);
  per-zone hidden counts; selection cleared restores the plain cut.
- `server/store.test.ts`: append→restart round trip preserves tail;
  corrupt JSON line and validator-rejected line are skipped with the
  rest intact; >2,000-line file compacts to 1,000 on append path;
  >8 MiB file refused with empty log; `.artifex` symlink refuses
  writes; append failure (read-only dir) warns without crashing.

## Browser / accessibility checks

- Search input has an accessible label; results use `listbox` /
  `option` roles with `aria-activedescendant` tracking the active
  row; Escape returns focus to the input.
- Contrast and touch-target rules from D12 hold for the new top-
  strip controls at default zoom.
- Narrow window: the search box shrinks but stays usable; the
  inspector overlay behavior is unchanged.

## Closure criteria

- All acceptance criteria (AC1–AC5) in `requirements.md` hold.
- `bun test` + `bun run typecheck` pass in this session.
- README status line and `specs/roadmap.md` updated (T4 done, next
  milestone named).
- No changes outside the T4 scope in the final diff; review flow
  (review passes) recorded if run before landing.
