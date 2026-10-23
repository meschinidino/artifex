# 2026-10-20-belt-ghost — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Ghost-default belts: requirements

Date: 2026-10-20. Builder testing: with nothing selected, mid band
draws every route at 0.55 steel (214 on the gate floor) — unreadable
spaghetti. Meanwhile a near-band selection shows zero belts (incident
routes to unrendered targets are culled). Feast or famine; no middle
ground. Same DESIGN.md tokens; only alphas and the cull change.

## Requirements

- BGR1: With no selection, mid/near structure belts ghost back
  (alpha 0.12): the connected-map texture stays, the noise goes.
  Live (pulse) belts keep full strength; far-band rollup unchanged.
- BGR2: A selection spotlights its incident routes at full
  strength (live 0.9 / struct 0.55, as today) even when the other
  endpoint is unrendered or off-view: incident routes bypass the
  rendered-set gate (unknown endpoints still drop, fully
  off-view bboxes still cull, lines clip at the viewport edge).
  Non-incident routes keep the gate and dim to 0.06 (as today).
- BGR3: `__belts.drawn` keeps counting incident routes (a
  selection with 8 outgoing reads drawn ≥ 8 once any are in
  view range). No wire change (`WIRE_VERSION` 1).

## Non-functional

- Same canvas-stroke batching (no new pass: the ghost is one
  alpha on the existing struct stroke). Coverage ≥95/95 both
  reporters. E2E isolation expectations unchanged (fixture is
  fully visible, so the bypass never fires there).

## plan.md

# Ghost-default belts: plan

## Touch list

- `floor-ui/belts-view.ts`
  - `classifyRoutes`: unknown endpoints always drop; the
    rendered-set gate applies to everything except incident
    routes under a selection (`isolatedId` set + from/to is the
    isolated id). View cull unchanged. Update the doc comment.
- `floor-ui/app.ts`
  - `drawBelts` struct stroke: alpha 0.55 when isolated, 0.12
    when nothing is selected. Update the doc comment.
- Tests: `floor-ui/belts-view.test.ts` (isolated incident to an
  unrendered endpoint draws; isolated non-incident to an
  unrendered endpoint still drops; no-selection gating
  unchanged — existing tests pin it).

## Not in scope

Belt hover-tracing, zone rollup at mid, belt caps/toggles,
far-band changes, wire changes.

## validation.md

# Ghost-default belts: validation

- New classifier unit tests (3 cases above); existing
  classifier + e2e isolation expectations green unchanged.
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check on the gate floor (screenshots): nothing-selected
  mid view reads quiet with live belts lit; selecting the
  8-outbelt file spotlights its routes (drawn ≥ 1, endpoints
  non-empty) where it read drawn 0 before.
