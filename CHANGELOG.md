# Changelog

Newest first. Spec dirs carry the full requirements/plans.

## Unreleased (branch `feat/ai-summaries`, done 2026-10-21, uncommitted)

- On-demand AI summaries for files and belts: plain-English
  fixed-key JSON over local `muse exec` (medium effort, tunable
  via `ARTIFEX_SUMMARY_EFFORT`), content-hashed cache, honest "AI
  summary · time" label with cached/outdated states, inline
  failure surfacing. (`specs/2026-10-21-summaries/`)
- Clickable evidence: via rows citing `line N:` expand the source
  inline (`get-lines` range fetch, radius 10/cap 25, cited line
  marked `>>`); re-click collapses; patch rewrites collapse the
  expansion. (`specs/2026-10-21-evidence/`)
- Summary readability: bold per-field blocks, short file names
  after first mention, well-backdrop contrast (DESIGN tokens only).

## 2026-10-21 (main through PR #27)

- Belt-click inspector (#27): edge card with uses evidence,
  per-file Go attribution, incident pair keeps selection,
  deselect-first empty click.

## 2026-10-20 (PRs #24–#26)

- Gate-readiness batch (#26): belt hover + ghost belts,
  orientation strip, footprint diff, open-file view.
- Overnight batch (#24): footprint overlays, instruction
  write-back, SQL/table contracts, preview export.
- Subdir git-status fix (#25).
- Agent interface T5 (`POST /agent` + annotate), run-cost readout,
  structural trace export.

## 2026-10-18

- Multi-repo federation (PR #10), Muse dispatch live (PR #11),
  coverage raised to raw ≥95 (PRs #9/#12/#14), membership policy,
  scale ceilings, layout compaction, session viewer.

## 2026-10-17

- Coverage to 95% value-weighted; committed E2E harness.

## 2026-10-16

- DESIGN.md (Nightshift Assembler) + AGENTS.md via consultation.

## 2026-10-14

- T4 floor store + 1,000-block escape hatch (PR #4); intent
  binding at ingest (PR #5).
