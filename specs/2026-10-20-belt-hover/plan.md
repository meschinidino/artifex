# Belt hover-trace: plan

## Touch list

- `floor-ui/route.ts`: `nearestRoute(routes, x, y, maxDist)` —
  pure closest-polyline pick (point-segment distance, first wins
  ties), undefined past maxDist or on empty input.
- `floor-ui/app.ts`:
  - `pointermove` (no drag, mid/near): world point via
    `toWorldPoint`, pick against `getBeltCache().routes` at
    `10 / camera.scale`, store/cursor/render on change.
  - `pointerleave`: clear.
  - `drawBelts`: after the struct pass, stroke the hovered route
    (ids resolved against the cache) ivory 3px; return its
    midpoint as `hoverTarget` (first drawn live/struct route).
  - `__belts` gains `hovered` + `hoverTarget` (type + init + update).
- Tests: `floor-ui/route.test.ts` (nearest cases);
  `e2e/floor.test.ts` (hover `hoverTarget` → probe pair → move
  away → null).

## Not in scope

Far-band rollup hover, endpoint machine outlines, touch
long-press trace, click-to-pin a trace.
