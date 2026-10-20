# Run cost readout: validation

Date: 2026-10-19. Run after implementation; all boxes must check
before the slice lands.

## Manual validation

- MV1 (rows): Boot the floor, dispatch two prompts (let one finish,
  leave one running or stop it). Confirm every Runs-list row shows a
  mono wall-time figure, newest first, with the running row's figure
  advancing on its own.
- MV2 (detail wall time): Select each run. Confirm `Started` /
  `Ended` / `Elapsed` match the row figure and `Ended` is `—` while
  running.
- MV3 (tokens absent — the expected live case): Confirm the detail
  `Tokens` row reads `Not reported by the agent` in muted text for
  a real dispatch. No zero, no blank row, no estimate.
- MV4 (tokens present — fixture-driven): Drive the server with the
  pinned usage fixture (test seam `spawnFn`, or the live shape if
  step 1 found one). Confirm compact `in · out` figures with exact
  `title` values, and a partial report rendering `—` for the missing
  direction.
- MV5 (channel re-probe): Re-run `muse exec --json --provider echo`
  and grep the captures for `"usage"` / `input_tokens`. Confirm the
  result matches the implementation's pinned set (today: still
  absent → MV3 is the live truth, not a bug).

## Technical checks

- TC1: `bun test` — full suite green (adapter, server, runs
  rendering, plus untouched suites).
- TC2: `bun run typecheck` — strict `tsc --noEmit` clean.
- TC3: Coverage gate holds: raw Bun function/line indicators ≥95
  (`scripts/coverage-gate.sh` path); new code covered by its tests.
- TC4: No hardcoded hex in new UI code (`grep` new styles/DOM for
  `#[0-9a-f]` outside token definitions); no new timer or
  animation-frame source in the Runs panel path.
- TC5: `WIRE_VERSION` is still 1 and `git diff --stat` touches only
  the slice's files (adapter + wire + server + runs UI + their
  tests).

## Expected unit / integration tests

- `agents/muse-adapter.test.ts`: usage parses from the pinned shape
  if one was found in step 1; otherwise, today's known payloads
  (terminal, deltas, tool results incl. `original_output_tokens`)
  yield no usage. Malformed usage (negative, float, string) dropped.
- `server/*.test.ts` (ghost/server seam): usage accumulates onto the
  live running run and marks the ledger dirty; monotonic per field
  (lower re-delivery ignored); ignored for stale plan ids and after
  terminal state.
- `floor-ui/runs.test.ts`: list rows carry the elapsed figure
  (running uses now, ended uses `endedAt`); detail `Tokens` states —
  full (`12.3k in · 4.1k out` + exact `title`), partial (`out —`),
  total-only (`12.3k total`), absent (`Not reported by the agent`);
  escaping of surrounding fields unchanged.

## Browser / accessibility checks

- Row elapsed figures are plain text inside the existing row
  buttons (no new focus target, no `aria-current` change).
- The `Tokens` row is a normal `dl` row readable by assistive tech;
  exact values are exposed via `title`, not color or position alone.
- Narrow window: rows wrap or clip without breaking the listbox
  layout; the inspector overlay behavior is unchanged.

## Closure criteria

- All acceptance criteria (AC1–AC5) in `requirements.md` hold.
- `bun test` + `bun run typecheck` pass in the landing session.
- MV5's probe result is recorded (landing note or PR body): which
  shapes were checked, what was found, and — if nothing — that
  honest absence is the shipped behavior.
- `docs/ideas.md` updated only as the builder directs (item
  graduated or left in intake); no scope creep beyond plan.md.
- No changes outside the slice in the final diff.
