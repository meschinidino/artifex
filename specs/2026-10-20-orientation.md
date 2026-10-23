# 2026-10-20-orientation — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Orientation readout: requirements

Date: 2026-10-20. Builder testing: "not clear where I'm at or what
I'm looking at (repo/folder wise)". The repo name sits in the
bottom curb, tiny and missed; the viewport location shows nowhere.

## Requirements

- ORR1: The top strip names the floor: a repo chip after the
  wordmark mirroring the snapshot `repo` label (single: repo
  basename; federated: `a + b`), same text as the curb.
- ORR2: The strip shows the viewport readout `◎ ZONE` — the zone
  (uppercased plate name) under the viewport center, `◎ —` when
  the center hits no zone. Updates as the camera moves (change-only
  DOM writes; no per-frame text churn).
- ORR3: Same tokens (mono readout, muted), no new hues, no layout
  shift in the strip (fixed slots, truncated chip).

## Non-functional

- No wire change (both derive from shipped state). Coverage
  ≥95/95 both reporters. E2E pins the chip mirror.

## plan.md

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

## validation.md

# Orientation readout: validation

- New layout unit tests (inside/outside/overlap-smallest/empty).
- New e2e test (chip === curb text after load).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: screenshot shows `vacations` chip + `◎ ADAPTERS`
  (or the landed zone); pan/zoom moves the readout.
