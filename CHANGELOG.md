# Changelog

Newest first. Spec dirs carry the full requirements/plans.

## Unreleased (branch `feat/typed-belts`, done 2026-10-21/22, uncommitted)

- Estate floor (factorio for D): `server/estate.ts` serves the frozen
  15-service mapping as machines (139 boxes + 12 thin services +
  3 yards + 12 unboxed) with 109 belts (84 http call flows, 25 steel
  couplings) over the unchanged wire protocol; client keys estate
  mode off the `estate:` repo prefix (box inspector rows, Files
  section, file-only features stood down, zero wrong labels).
  Gateway-exposure slice: frozen route table marks which
  endpoints face frontends (`Exposed` row + `· exposed` suffix;
  11 services exposed, compras/chequera-proxy internal).
  Fresh rebuild on pulled code (1339 endpoints, 153 boxes).
  Frontend layer: 6 app machines, 115 proven call belts +
  70 UNMATCHED intent belts (69 compras void-calls + 1
  limite path/query drift). (`specs/2026-10-22-estate.md`)

- Typed belts (legibility Pass 1): import solid / http dashed /
  topic dotted (graphite only), width by citation count,
  near-band carried-symbol labels (mid: hub belts), hover
  endpoint lighting. Zero wrong labels across the panel
  (artifex/nds-capital/lipgloss). (`specs/2026-10-21-legibility.md`)
- Belt purpose phrases (builder ask on Pass 1): contract belts
  phrase from rules (`fetches orders`, `publishes orders`);
  import belts from one cached LLM batch behind a Phrases
  trigger (unasked/pending/ready/stale/error, staleness by belt
  hash, hover reads `phrase — symbols`). Live panel batches:
  207/207 artifex, 73/73 nds-capital, 248/390 lipgloss (bare
  Go fan-out honestly skipped), zero wrong phrases.
  (`specs/2026-10-21-purpose-phrases.md`)
- Usage evidence for long imports: the TS statement window
  grows 15→64 lines and truncated single-line cites get a uses
  item, so big-file belts name their symbols (hover halves,
  phrase inputs). Closes two Pass 1 validation follow-ups.

## 2026-10-21 (PR #28)

- On-demand AI summaries for files and belts: plain-English
  fixed-key JSON over local `muse exec` (medium effort, tunable
  via `ARTIFEX_SUMMARY_EFFORT`), content-hashed cache, honest "AI
  summary · time" label with cached/outdated states, inline
  failure surfacing. (`specs/2026-10-21-summaries.md`)
- Clickable evidence: via rows citing `line N:` expand the source
  inline (`get-lines` range fetch, radius 10/cap 25, cited line
  marked `>>`); re-click collapses; patch rewrites collapse the
  expansion. (`specs/2026-10-21-evidence.md`)
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
