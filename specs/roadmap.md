# Roadmap: Artifex

Ordered milestones. Statuses: `done`, `next`, `blocked`, `deferred`.
Details live in `TODOS.md` (task tracking) and the design doc
(`docs/designs/artifex-ghost-factory.md`); this file orders them.

## Done

- [x] **T1 — Protocol spike** (`spike/RESULTS.md`): agent capability
  matrix measured live (Muse + Claude Code elicited intent, Codex
  partial, OpenCode unverified). Builder gate inputs recorded.
- [x] **T2 — Shared events module** (`events/`): typed events,
  stateless shape/provenance validator, tests.
- [x] **T3a — Ground layer** (issue #2): watcher, parser, layout,
  live floor without belts. Pre-landing reviewed.
- [x] **T3b — Import belts** (issue #3): `imports[]` extraction,
  resolver, belt wiring, zoom-gated render. Reviewed over 3 rounds,
  structured gate passes, committed (`71f5d59`).
- [x] **T4 — Floor store + 1,000-block escape hatch** (P1): search /
  zoom-to-file (`floor-ui/search.ts`, selection exemption in
  `floor-ui/visible.ts`, `+N hidden` pads); durable event log
  (`server/store.ts`, `.artifex/event-log.jsonl`). Spec in
  `specs/2026-10-14-t4-floor-store-escape/`.

## Next: make the floor honest (validation blockers)

- [ ] **Intent binding at ingest** (P1, needs T4): intended events must
  reference a previously ingested `planned` event; forged/stale plan
  IDs stay observed or rejected, with regression tests.
- [ ] **Scale ceilings with visible refusal** (P2, needs T8 numbers):
  explicit file-count ceiling, parser watchdog, capped giant-file
  line counting.
- [ ] **One membership policy** (P2, needs builder decision): single
  eligibility rule for scan and watcher (gitignore-honoring vs
  hard-excludes-only).
- [ ] **Layout compaction policy** (P2): reclaim append-only layout
  space (gap reuse or suggested relayout).

## Then: validate, then ghosts

- [ ] **Single-repo validation gate** (D21): the floor is trustworthy
  on a real repo. Unblocks everything below.
- [ ] **Ghost layer ships**: elicited intent renders from measured
  channels; the floor shows agents working, not just files existing.
- [ ] **DESIGN.md consultation** (P3, unblocked now): grow the D11
  token seed into a full design system against real rendered density.

## Deferred (P3)

- [ ] **Multi-repo federation**: districts per repo, cross-repo belts
  from real contract links only. Gated on the validation gate.
- [ ] **Replay Theater**: scrubbable session timelines on the event
  log. Gated on the shipped ghost layer.

## Open decisions (builder)

- Close issues #2/#3 once audit/perf numbers are pasted (code landed).
- Membership policy: gitignore-honoring everywhere vs hard-excludes only.
- T7 DB engine list (one ORM + raw SQL in v1; engines open).
- When to run the DESIGN.md consultation.
