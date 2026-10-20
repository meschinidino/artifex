# Open-file view: requirements

Date: 2026-10-20. Builder testing: "being able to open and see the
file ... would be good". The inspector FILE pane is 286 px wide —
fine for orientation, poor for reading. One click opens the whole
loaded file on a large surface.

## Requirements

- OFV1: A FILE section Expand control opens a full-viewport
  overlay sheet with the selected file's loaded text (same bytes
  as the inspector pane, up to its cap — no second fetch) under
  the file path. Mono, both axes scroll, line shape preserved.
- OFV2: Dismissal: close control, scrim click, Escape (first in
  the cascade — the overlay is the topmost layer), and selection
  change/deselect. Focus returns to Expand on close.
- OFV3: Same tokens (surface-2 sheet, plate border, Saira label
  header); no new hues. Frozen previews: no Expand (no content
  ever loads, so the control never appears).

## Non-functional

- No wire change, no socket traffic. Coverage ≥95/95. E2E pins
  open → content match → Escape/scrim close.
