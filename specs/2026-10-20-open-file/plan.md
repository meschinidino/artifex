# Open-file view: plan

## Touch list

- `floor-ui/index.html`: FILE head row (title + `#file-expand`
  button, hidden with the section) + `#file-overlay` sheet
  (scrim, path head, close, `#file-overlay-content`).
- `floor-ui/styles.css`: head row, overlay/sheet/close styling,
  phone full-bleed rule.
- `floor-ui/app.ts`: open/close wiring (content copied from the
  loaded pane), Escape first in the cascade, scrim + close
  dismissal, auto-close on selection change, focus return.
- Tests: `e2e/floor.test.ts` (open/match/close × Escape+scrim).

## Not in scope

Second-fetch full text past the 256 KB cap, in-overlay search,
line numbers, editing, per-line selection links.
