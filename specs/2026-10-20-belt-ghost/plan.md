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
