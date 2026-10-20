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
