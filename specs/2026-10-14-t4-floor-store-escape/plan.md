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
