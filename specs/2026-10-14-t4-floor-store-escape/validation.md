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
