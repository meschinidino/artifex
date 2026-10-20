# Comprehension gate — prep record: hrapp/internal/vacations

Date: 2026-10-19. Compiled per `docs/gates/comprehension-runbook.md`.
Status: PREPPED — run postponed by builder 2026-10-19 as early ("needs a more readable product first"). Builder also confirmed option A: D21 freeze holds, T6/T7 only after the gate passes. Prep stays valid; still needs X pick (non-builder) + viewer session when resumed.

## Target (builder-named)

`/Users/dinomeschini/Documents/hrapp/internal/vacations` (Go).

- 52 `.go` files in 4 folders (`domain`, `application`, `adapters`,
  `leavetypes`). Boots on the floor verified 2026-10-19: 52 buildings,
  no error flood (checked on a `/tmp` copy; the real repo untouched).
- Two areas for Q1: vacation rules/policies (`domain`) + leave
  requests and types (`application`, `leavetypes`, `adapters`).

## Recorded deviation: size band

Runbook eligibility says ~20 files (12–30); this target has 52.
Accepted as a recorded deviation, not an auto-fail: the in-band
alternatives were worse (the 17-file core has no clean one-area recent
change; `adapters/api` is flat and single-area). The tree control faces
the same 52 files, so the comparison stays fair. If the viewer is
visibly lost in both conditions, record it in Caveats rather than
rounding it away.

## The change (Q2) — frozen before the session

Commit `a330dcb` "feat: add configurable list ordering" (already in
history): 3 files, all in `adapters/api`, plain-words answer "lists
can now be sorted in different orders". Sealed from the viewer.

## X candidates (Q3) — NON-BUILDER PICKS ONE

Proposed (each belongs in exactly one area):

1. A report of who is on vacation next month (→ stats/report area).
2. An email reminder before a vacation starts (→ application flows).
3. A new leave type "study leave" (→ leavetypes).

The builder must NOT pick. Record who picked and which.

## Session logistics (still open)

- Viewer: non-technical, never seen hrapp or Artifex. Needed ~15–20 min.
- Floor boots from the real path (verified working on a copy).
- Plain tree view of the same dir for the control condition.
