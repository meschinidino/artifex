# Subdir footprint status: requirements

Date: 2026-10-20. Amends `specs/2026-10-19-footprint-overlays/requirements.md`
FR2/FR3 (status source only — wire, treatments, and tombstones are
unchanged). Motivating case: the comprehension gate serves
`hrapp/internal/vacations`, a subdir of a git work tree; today its
label has no `.git` at the root, so status is never queried and Q2
("what just changed?") is unanswerable from the map. Silently
dropping overlays for every subdir-served repo is the same trap in
general.

## Amended requirements

- SFR1: A label root is git-backed when a `.git` entry exists
  at the root itself (any shape — FR3's unresolvable case keeps
  boot/flush triggers without watches), or when a valid
  enclosing work tree resolves above it (nearest ancestor
  `.git`, directory or valid `gitdir:` pointer). Git-backed
  labels are queried on the FR3 triggers. Labels with no root
  `.git` and no enclosing work tree keep the old rule (never
  queried).
- SFR2: Status output paths are always work-tree-relative: the
  status argv pins `-c status.relativePaths=false` so a viewer-side
  gitconfig can never silently change the path form. Records are
  relativized to the label root before any other handling: paths
  under the root's prefix are stripped, records outside it are
  dropped. A collapsed untracked dir at the label root, or at any
  ancestor above it, expands to every listed member (the whole
  label root is untracked); a collapsed dir under the prefix
  expands as FR1 does against the stripped prefix. Rename framing
  still consumes the old-path field even when the new path is
  out of scope.
- SFR3: The FR3 index/HEAD watches resolve through the enclosing
  `.git`, so subdir labels get commit/stage/checkout triggers
  exactly like root labels (same echo-signature gate).

## Unchanged

- FR1 verdict table, FR4–FR17, NFR1–NFR4, NFR6. Toplevel-served
  repos behave byte-for-byte as before (empty prefix = no
  stripping). `WIRE_VERSION` stays 1.
- NFR5: coverage stays ≥95 raw function/line on both Bun
  reporters; every new branch carries a test.
