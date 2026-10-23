# 2026-10-21-summaries — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# AI summaries: requirements

Date: 2026-10-21. Builder decision (P1A/P2A/P3A): on-demand AI
summaries of files and belts as an enhancement layer — never
replacing code or static evidence. In scope for the gate, so
honest labeling is part of the contract.

## Requirements

- SUM1: On-demand "Summarize" buttons: file inspector and edge
  card. Click → loading state → summary section. Second click
  with unchanged content answers instantly from cache.
- SUM2: File summary context: file content (8 KB cap) + in/out
  belts with uses evidence (20 neighbors cap) + zone +
  footprint status. Prompt: fixed-key JSON {what, why, fits}
  (≤40 words each) in plain English for a non-programmer (jargon
  ban, no pasted code); server formats the 3 labeled lines.
- SUM3: Belt summary context: endpoints + their content (2 KB
  each) + edge kinds + via evidence, each endpoint's fan (counts
  + top 5 neighbors). Prompt: fixed-key JSON {flows, why, broke},
  same plain-English rules; server formats the 3 labeled lines.
- SUM4: Honest labeling (gate contract): every summary shows
  "AI summary · <time>" plus Regenerate; code/evidence stay one
  click away (summary is an added section). A patch touching the
  target marks it outdated ("changed since") until regenerated.
- SUM5: Runner: local `muse exec` (plain stdout), prompt via
  temp prompt-file (never argv), 120 s timeout, workspace = repo,
  `--reasoning-effort` (default medium, user-tunable via
  ARTIFEX_SUMMARY_EFFORT; invalid falls back to medium).
  Prompt constrains to provided context (no tool runs expected;
  verified live). Failures surface in-UI, never blank.
- SUM6: Cache: in-memory, keyed by sha1 of kind+target+content
  +neighbors, cap 100 (oldest evicted); responses flag cached.
  Deterministic e2e via ARTIFEX_SUMMARY_STUB (text + error).

## Non-functional

- New wire pair `get-summary`/`summary` (+ `error`
  code `summary-failed`); additive, no version bump.
  DESIGN.md: existing inspector classes only. Coverage ≥95/95.

## plan.md

# AI summaries: plan

1. Wire (`floor-ui/wire.ts`): `GetSummaryMessage` (file path or
   belt pair target), `SummaryMessage` (target echo, text,
   generatedAt, cached).
2. Server (`server/summarize.ts`, new): pure context assembly
   (caps, neighbor formatting, prompts) + cache + runner over
   injectable spawn (`muse exec`, prompt-file, 120 s timeout) +
   ARTIFEX_SUMMARY_STUB modes. `server/index.ts`: build contexts
   from buildings/belts/file text, answer `get-summary`.
3. Client (`floor-ui/app.ts` + `index.html`): Summarize buttons
   (file head, edge jumps), summary sections with AI label +
   meta + Regenerate, loading/error/outdated states, reset on
   selection change.
4. Tests: `server/summarize.test.ts` (prompts, caps, cache,
   runner success/timeout/failure, stub), e2e file + belt +
   error via stub.

## validation.md

# AI summaries: validation

- Unit: prompt assembly (caps, neighbor/uses inclusion),
  cache key/cache-hit/eviction, runner (ok/timeout/nonzero),
  stub text + error modes.
- E2E: file summarize → stub text + AI label; belt summarize
  → stub text; stub error → in-UI error; regenerate after
  patch → outdated clears.
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check (branch floor, REAL muse run): file + belt
  summaries render with label + time; latency noted.

## Results (2026-10-21, branch feat/ai-summaries)

- Unit: 674 pass / 0 fail; summarize.test.ts 11/11
  (prompt assembly, cache key/hit/eviction, pending dedup,
  runner ok/timeout/nonzero, stub modes, 3 socket round-trips).
- `bun run typecheck` green; coverage gate 97.51/97.70 (bar 95/95).
- E2E: floor 44/44 (4 summary tests: file+cache, belt,
  failure-inline, outdated→regenerate), browse+preview 12/12.
- Live REAL `muse exec` (no stub): file summary for
  server/summarize.ts in 17.8s, coherent prose, 1 paragraph +
  bullets, labeled with AI summary + timestamp.
- Follow-up (same day): effort medium via ARTIFEX_SUMMARY_EFFORT
  (default, in cache key); plain-English 3-line format; belt
  context +2 KB endpoint content. Live: belt route→layout 14.9s
  ("draws paths between machines... belts could cut through
  machines"), file 20-50s (high agent variance; medium does not
  guarantee faster than max).
- Format fix (same day): model answers a fixed-key JSON object;
  server formats the 3 labeled lines (newlines guaranteed) with
  fenced/wrapped tolerance + raw-text fallback; UI keeps breaks
  (pre-line). Live belt 23.6s, 3 lines confirmed.
- Readability (same day): client stamps one spaced block per
  labeled line with bold labels (textContent-only); prompt uses
  full path once then short file names. Live belt 32.1s obeys;
  e2e asserts the field blocks.
- Flakes fixed along the way: failure test must request an
  uncached file (shared e2e server cache); Summarize click must
  wait for the preview head.
