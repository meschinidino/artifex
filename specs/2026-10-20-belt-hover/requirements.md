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
