# Run cost readout: requirements

Date: 2026-10-19. Implements `docs/ideas.md` "Run cost readout" as a
small complete slice. Design authority: `DESIGN.md` (mono counts,
missing data shown as missing, no new hues), `specs/mission.md`
(text is truth — no unproven state rendered).

## Functional requirements

### Wall time (always)

- FR1: Every row in the Runs list shows the run's wall time as a
  mono elapsed figure, computed from the run's `startedAt` /
  `endedAt` with the render time as now — the same `formatElapsed`
  rules the detail view uses (`5s`, `1m 5s`, `1h 1m`).
- FR2: The running run's row figure stays live on the panel's
  existing re-render cadence (patch arrival + the current
  while-running refresh). No new timer, no per-frame work.
- FR3: List order (newest first), selection (`aria-current`), row
  title, and start-clock behavior are unchanged; the elapsed figure
  is an addition to the row, not a replacement.
- FR4: The detail view keeps its `Started` / `Ended` / `Elapsed`
  rows with current semantics (`Ended` is `—` while running).

### Token usage (where reported)

- FR5: `RunRecord` carries an optional
  `usage?: { inputTokens?: number; outputTokens?: number;
  totalTokens?: number }`. Absent `usage` (or an absent direction
  within it) means the agent did not report it — never zero, never
  estimated.
- FR6: The adapter exposes usage as a `MuseStreamEvent` (`usage`
  kind) parsed only from measured, fixture-pinned payload shapes.
  Unmeasured shapes — including all of today's known payloads if
  step 1 finds nothing — yield no usage event.
- FR7: Usage values must be non-negative safe integers; any other
  shape (negative, float, string, missing) drops the usage event
  (or that direction of it) rather than coercing or guessing.
- FR8: The server stamps usage onto the matching run only while it
  is the live run (`planId === activePlanId`, state `running`) and
  marks the ledger dirty, exactly like the existing answer-text
  path. Stale or post-terminal usage lines are ignored.
- FR9: Accumulation is monotonic per field: a usage event replaces
  a direction's stored value only when the new value is greater.
  Duplicates and reordered lines can never shrink a total.
- FR10: The detail view shows a `Tokens` row under `Elapsed`:
  - both directions reported: compact `12.3k in · 4.1k out` with
    exact figures in the `title` attribute;
  - one direction reported: the reported figure plus `—` for the
    missing direction (e.g. `12.3k in · out —`);
  - nothing reported: the muted words `Not reported by the agent`.
- FR11: The `tool.result` `original_output_tokens` field is never
  parsed as usage, never accumulated, never displayed as cost.

## Non-functional requirements

- NFR1: No wire version bump (`WIRE_VERSION` stays 1): the `usage`
  field is additive-optional on a type both sides import from one
  bundle. No new production dependencies; Bun + strict TypeScript
  throughout.
- NFR2: No new always-on work: row figures render on existing panel
  renders only; usage accumulation is O(1) per stream line at agent
  event rate. Potato budgets unchanged.
- NFR3: Tokens-only styling for new UI; figures in mono, row header
  in the existing label style; states never color-only; no new hue,
  radius, or nested plates (DESIGN.md).
- NFR4: Reduced-motion and idle-render rules hold: no new animation
  or timer; the running-row tick rides the existing refresh.
- NFR5: Regression tests accompany every behavior change, with
  `Value:` comments per repo convention; the coverage gate
  (≥95 raw indicators) must not regress.

## Content / data requirements

- Usage integers are plain counters: nothing to secret-mask, no
  truncation rule (bounded small integers by validation).
- `usage.totalTokens`, when present without directions, renders as
  `12.3k total` (same compact rule, same `title` exactness).

## Acceptance criteria

- AC1: On a live floor with past and running runs, every Runs-list
  row shows a wall-time figure; the running row's figure advances
  without interaction; detail `Elapsed` matches the selected row.
- AC2: A run whose agent reports nothing shows `Not reported by the
  agent` in the detail `Tokens` row — no zero, no blank, no estimate.
- AC3: A run fed a fixture-pinned usage shape (or a live shape, if
  step 1 finds one) shows compact in/out figures with exact `title`
  values, and partial reports show the reported direction with `—`
  for the other.
- AC4: Malformed usage (negative / float / string) and
  `tool.result` token counts never appear as run cost; a test pins
  each rejection.
- AC5: `bun test` and `bun run typecheck` pass; new behavior has
  regression tests (adapter parse, server accumulation, list/detail
  rendering).
