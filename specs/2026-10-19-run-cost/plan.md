# Run cost readout: plan

Date: 2026-10-19. Roadmap intake: `docs/ideas.md` "Run cost readout".
Status: spec only — no code, no behavior change.

## Objective

Show what each dispatch cost in the session viewer Runs panel: wall
time always, token usage where the agent reports it. Runs are already
work orders with prompts and outcomes (`RunRecord` in
`floor-ui/wire.ts`, ledger in `server/index.ts`, panel in
`floor-ui/runs.ts` + `floor-ui/app.ts`); cost per order is the missing
column, and the honest basis for spotting expensive patterns later.

## What exists today (measured, not assumed)

- **Wall time, server side:** `startDispatch` stamps
  `startedAt: Date.now()` on the new run; `endRun` stamps `endedAt`
  on every terminal transition (`done` / `error` / `stopped`,
  including spawn failure and timeout). Both ride the existing
  `runs` snapshot/patch payloads. Nothing to add here.
- **Wall time, client side:** `formatElapsed` + the detail panel's
  `Elapsed` row already show it per selected run. The **list rows**
  show only title + start clock — no per-row cost, so comparing runs
  means clicking each one. That is the gap this slice closes.
- **Token usage: no channel exists.** Verified three ways on
  2026-10-19, all negative:
  1. `agents/muse-adapter.ts` parses `todo` / `text` / `activity` /
     `terminal` / `other` — no usage kind.
  2. `spike/captures/muse-elicited.json`, `muse.json`, and
     `muse-why.jsonl` contain zero `"usage"` keys and zero
     `input_tokens` keys across 20 distinct payload types; the
     `run.terminal.completed` payload carries only
     `kind`/`command_id`/`terminal`/`text`/`reason`.
  3. A live `muse exec --json --provider echo` probe emits the same
     terminal shape with no usage fields.
- **False friend:** `tool.result` payloads carry a per-tool
  `original_output_tokens` count. That is tool-output truncation
  accounting, not model usage — summing it as run cost would be a
  lie. Explicitly out of scope (see below).

Net: wall time is collected but under-surfaced; tokens need new
plumbing that must degrade honestly because every run today reports
nothing.

## Scope

In scope:

- Per-row wall-time readout in the Runs list (newest-first order
  unchanged): each row gains a mono elapsed figure, live for the
  running run on the panel's existing re-render cadence.
- Optional `usage` on `RunRecord` (`inputTokens` / `outputTokens` /
  `totalTokens`, all optional integers), carried over the existing
  `runs` snapshot/patch payloads with no wire version bump (additive
  optional field; the server serves the client bundle, so both sides
  ship together).
- Adapter seam: a `usage` stream-event kind in
  `agents/muse-adapter.ts`, parsed only from measured payload shapes
  (the measured set is currently empty — see step 1), accumulated
  per live run by the server.
- Detail panel `Tokens` row: compact `in / out` figures when
  reported, an explicit not-reported state otherwise. Never blank,
  never zero-filled.
- Unit tests for the new builders/parser/accumulation; existing
  suites stay green.

Out of scope:

- Cross-run totals, averages, sorting by cost, or any "expensive
  patterns" aggregation (the idea's stated future; this slice only
  lays the per-run basis).
- Summing `tool.result` `original_output_tokens` as usage.
- Model labels (`run.model.configured` carries `model_id`, but cost
  is time + tokens, not provenance).
- Monetary cost (no price table exists; tokens are the unit).
- Any wire version bump, new production dependency, or protocol
  change beyond the additive optional field.
- Persisting the ledger (it stays per-boot per the session-viewer
  design).

## Proposed architecture

### 1. Adapter: measured-shapes-only usage parsing

- New `MuseStreamEvent` variant:
  `{ kind: "usage"; inputTokens?: number; outputTokens?: number; totalTokens?: number }`.
- `parseMuseLine` gains a usage branch that fires only for payload
  shapes pinned by a captured fixture (same discipline as the
  `todo.snapshot.updated` channel: no fixture, no claim). Step 1
  re-probes for such a shape; if none is found, the branch ships
  recognizing nothing and the parser tests pin that today's known
  payloads (terminal, deltas, tool results) yield no usage.
- Validation rules, shared with the existing adapter style:
  non-negative safe integers only; anything else (negative, float,
  string, absurd) drops the usage event rather than guessing.
  Partial reports are kept partial (`inputTokens` without
  `outputTokens` is legal) — the UI renders what is there.

### 2. Server: accumulate per live run

- `handleAgentLine` handles `usage` like `text`: only for
  `planId === activePlanId`, stamped onto the matching `running`
  run, then `touchRuns()`.
- Accumulation policy: usage events replace per-field when the new
  value is greater (monotonic counters), so reordered or duplicate
  lines cannot shrink a total. Documented in one place next to
  `appendRunText`.
- No other server change: `startedAt`/`endedAt` already flow, and
  `MAX_RUNS` / masking / truncation rules are untouched (usage is
  plain integers — nothing to mask).

### 3. Client: two readouts, one honesty rule

- List row: append a mono elapsed span (`formatElapsed` with the
  render-time `now`, reusing the existing builder). Running rows
  tick on the panel's current re-render cadence (patch arrival +
  the existing while-running refresh) — no new timer.
- Detail: a `Tokens` row under `Elapsed`:
  - both directions: `12.3k in · 4.1k out` (compact thousands, one
    decimal, exact figures in `title`);
  - partial: `12.3k in · out —`;
  - absent: `Not reported by the agent` (muted, plain words — the
    DESIGN.md "missing data as missing" rule).
- Styling from CSS tokens only, mono for figures, Saira label for
  the row header — matching the existing detail `dl` and
  `DESIGN.md` (no new hue, no new radius, no plate nesting).

## Implementation steps

1. Re-probe for a usage channel: re-run the echo probe and grep the
   captures for `usage` / `input_tokens`. If a shape appears, save a
   minimal fixture and pin the parser to it; if not (expected),
   record the negative result in the PR/landing note and proceed —
   the plumbing plus honest absence is the complete slice.
2. `agents/muse-adapter.ts`: `usage` event kind + guarded parse
   branch + tests (valid shape if found; else: known payloads yield
   no usage; malformed usage dropped).
3. `floor-ui/wire.ts`: optional `usage` on `RunRecord` (comment:
   absent = agent did not report, never zero).
4. `server/index.ts`: accumulate usage on the live run in
   `handleAgentLine` + tests (accumulate, monotonic-per-field,
   ignored after run end, ignored for stale plan ids).
5. `floor-ui/runs.ts`: elapsed span in `renderRunsList` rows,
   `Tokens` row in `renderRunDetail` + compact-number formatter +
   tests (row shows elapsed; detail states for full/partial/absent;
   escaping unchanged).
6. `bun test` + `bun run typecheck`; manual Runs-panel check on a
   live floor (one real dispatch: row shows ticking elapsed, detail
   shows wall time + not-reported tokens).
7. Update `docs/ideas.md` (item graduated to spec) and
   `specs/roadmap.md` only if the builder promotes it to roadmap
   work — the spec itself does not move it.

## Risks / decisions

- **The likely outcome is plumbing with nothing flowing through it.**
  That is the honest slice, not a failure: wall-time readout is the
  user-visible win, and the usage path is ready the day `muse`
  reports it. The spec forbids filling the gap with estimates or
  tool-output token sums.
- **A usage shape could appear mid-implementation** (new `muse`
  release). Step 1 exists to catch exactly that; the parser branch
  is designed to accept one pinned shape with no rework.
- **Running-row ticking** reuses the existing refresh path, so no
  new perf surface: one short string per row on renders that already
  happen.
- **No wire bump** is safe because server and client ship as one
  bundle; an additive optional field cannot break the versioned
  snapshot/patch sequencing.

## Assumptions (flagged, decided autonomously)

- A1: `muse exec --json` remains the only adapter; no second agent's
  usage shape is designed for.
- A2: Monotonic-per-field accumulation is right because usage lines,
  if they ever come, will be cumulative counters like every other
  streaming usage API; if the first measured shape turns out to be
  per-delta, step 1 revisits this before code lands.
- A3: Compact `12.3k` rendering with exact `title` matches the
  Operate register better than full-width integers in narrow rows.

## Expected result

Every run in the Runs panel shows its wall time at a glance, and the
detail view shows token usage when the agent reports it or says
plainly that it did not — per-order cost, honestly rendered, with
the aggregation the idea wants left as clean follow-up work.
