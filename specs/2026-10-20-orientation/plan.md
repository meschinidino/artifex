# Orientation readout: plan

## Touch list

- `floor-ui/layout.ts`: `zoneAtPoint(zones, x, y)` — smallest-area
  zone containing the point (deterministic under overlap), else
  undefined. Pure; unit-tested.
- `floor-ui/index.html`: `#repo-chip` after the wordmark,
  `#view-zone` inside `.strip-counts`.
- `floor-ui/styles.css`: chip + readout styling (mono, muted,
  ellipsis; narrow-strip rules keep them out of the way).
- `floor-ui/app.ts`: set the chip where the curb repo-name is set;
  per-frame (in `draw`, next to the `__floor` probe update)
  compute the viewport center via `worldViewport`, resolve the
  zone, write `#view-zone` only on change.
- Tests: `floor-ui/layout.test.ts` (`zoneAtPoint` cases);
  `e2e/floor.test.ts` (chip mirrors curb repo-name after load).

## Not in scope

Breadcrumbs of selection path (inspector shows it), minimap
viewport rect changes, far-band zone rollup labels.
