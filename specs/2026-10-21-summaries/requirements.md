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
