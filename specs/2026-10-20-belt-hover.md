# 2026-10-20-belt-hover — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Belt hover-trace: requirements

Date: 2026-10-20. Builder testing: "some kind of interaction where
belts cross to indicate where each belt is going would be good."
Hover a belt: spotlight its full path so the eye can trace
producer → consumer through crossings.

## Requirements

- BHT1: At mid/near bands, hovering within 10 screen px of a routed
  belt highlights the whole route (ivory, full alpha, 3px) above
  the batched strokes, and flips the canvas cursor to pointer.
  Leaving the belt (or the canvas, or zooming to far) clears it.
- BHT2: `__belts.hovered` reads `[fromId, toId]` or null (diag +
  e2e seam). `__belts.hoverTarget` offers one guaranteed-hoverable
  world point `{ x, y, fromId, toId }` (midpoint of the first
  drawn route's longest segment) or null when nothing draws.
- BHT3: Same tokens (ivory highlight exists for selection;
  hover reuses the hue at belt weight, never the selection
  rect language). No wire change.

## Non-functional

- Hit-test is O(segments) per pointermove with render only on
  change (no per-move renders while settled). Coverage ≥95/95.
  E2E pins hover → probe → clear through `hoverTarget`.

## plan.md

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

## validation.md

# Belt hover-trace: validation

- New route unit tests (closest/first-wins-ties/past-max/empty/
  degenerate zero-length segment).
- New e2e hover test (deterministic via `hoverTarget`).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: screenshot with a hovered route dispatched at
  `hoverTarget` shows the ivory trace + pointer cursor.
