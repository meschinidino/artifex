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
- [x] **Intent binding at ingest** (P1, PR #5): `server/intent.ts`
  gate — intended events must reference a previously ingested
  `planned` event in the same session; forged/stale IDs stay
  unbound, with regression tests.
- [x] **DESIGN.md consultation** (2026-10-16): Nightshift Assembler
  system + `AGENTS.md`; interactive preview reviewed over 16 rounds
  to outside sign-off.

- [x] **Serious coverage to 95%** (P1, 2026-10-17; raw indicators
  raised to ≥95 on both Bun reporters 2026-10-18, PRs #9/#12/#14):
  377 unit pass / 0 fail, 32/32 E2E, typecheck clean; every test
  carries a `Value:` comment, residuals named in
  `docs/coverage-reaudit.md`. Four real watcher bugs fixed. Branch
  coverage is 71.1% (Istanbul) — recorded in the same doc, not gated.
- [x] **E2E harness** (P1, 2026-10-17): committed `e2e/` — browse
  wrapper with SIGKILL watchdog, mini-floor fixture, browser +
  harness tests, CI workflow (E2E only; unit/typecheck are not in
  CI yet); zero-console-errors after every test.
- [x] **Single-repo validation gate** (D21): the floor is trustworthy
  on a real repo. Unblocks everything below. (Proven on a private multi-repo Java project
  against grep ground truth, PR #10.)
- [x] **Ghost layer ships**: elicited intent renders from measured
  channels; the floor shows agents working, not just files existing.
  (Muse dispatch live 2026-10-18, PR #11; more adapters later.)
- [x] **Multi-repo federation**: districts per repo, cross-repo belts
  from real contract links only. (Shipped in PR #10.)

## Next: make the floor honest (P2)

- [ ] **Scale ceilings with visible refusal** (needs T8 numbers):
  explicit file-count ceiling. Parser watchdog (60 s), the 1 MiB
  parse cap, and 8 MiB state/log caps already exist; the missing
  piece is a truthful refusal before memory blows up.
- [ ] **One membership policy** (needs builder decision): single
  eligibility rule for scan and watcher (gitignore-honoring vs
  hard-excludes-only). Today the git listing honors gitignore and
  the live watcher does not, so gitignored files flap.
- [ ] **Layout compaction policy**: reclaim append-only layout
  space (gap reuse or suggested relayout).

## Then: product steps (design tasks, still open)

- [ ] **Agent interface** (design T5): queries plus annotate, token
  bootstrap (D19), safety contract (D18).
- [ ] **Prompt/talk** (design T6): dispatch prompts already ship with
  the ghost layer; ask-why per capability-matrix labels is still open.
- [ ] **DB zone** (design T7): connections already prove endpoint→table
  reachability in the inspector; the schema-view zone is still open.
- [ ] **Gates** (design T8): comprehension (D5/D16 control) and potato
  (D3/D15 thresholds) scored protocols recorded in the repo; the T8
  decision also unblocks the scale-ceiling numbers above.

## Deferred (P3)

- [ ] **Replay Theater**: scrubbable session timelines on the event
  log. Gated on the shipped ghost layer.

## Open decisions (builder)

- Membership policy: gitignore-honoring everywhere vs hard-excludes only.
- T7 DB engine list (one ORM + raw SQL in v1; engines open).
