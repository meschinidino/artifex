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
