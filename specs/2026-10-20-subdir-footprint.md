# 2026-10-20-subdir-footprint — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Subdir footprint status: requirements

Date: 2026-10-20. Amends `specs/2026-10-19-footprint-overlays.md`
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

## plan.md

# Subdir footprint status: plan

## Touch list

- `watcher/gitstatus.ts`
  - `findWorkTree(root)`: nearest enclosing `.git` at or above
    `root` (reuses `resolveGitdir` per level). Returns
    `{ toplevel, prefix, gitdir }` (`prefix` = POSIX root-rel,
    `""` at the toplevel) or `undefined`.
  - `GIT_STATUS_ARGV` gains `-c status.relativePaths=false`
    (SFR2: deterministic path form).
  - `PorcelainOpts.prefix?`; `parsePorcelainZ` scopes every
    record path through the prefix (strip / drop / ancestor
    expansion per SFR2) before verdicts and member expansion.
  - `readGitStatus` resolves the prefix via `findWorkTree` and
    passes it through; no other behavior change.
- `server/index.ts`
  - Label `git` flag: `findWorkTree(root) !== undefined`
    (was: `.git` directly under the root).
  - `watchGitdir` resolves via `findWorkTree(root)?.gitdir`
    (covers root `.git` too).
- Tests: `watcher/gitstatus.test.ts` (argv pin update,
  `findWorkTree` cases, prefix-scoped parse cases, real-git
  subdir `readGitStatus`), `server/footprint.test.ts` (fake-git
  ancestor gate test with a scripted runner; real-git subdir
  served-root test asserting `foot` + counts).

## Edge table

| Case | Result |
|---|---|
| Root served (prefix `""`) | byte-identical to today |
| Subdir served, in-scope dirty files | stripped verdicts stamp members |
| Dirty files outside the label root | dropped, never counted |
| Label root itself untracked (collapsed at/above prefix) | all members `added` |
| Non-repo root | never queried (as today) |
| `.git` file (linked worktree) at an ancestor | resolves, watches attach |
| Federated sibling subdirs of one repo | one run per label, own prefix each |

## Not in scope

UI, wire, tombstones, listing/gitignore handling, e2e additions
(no rendered behavior changes for existing fixtures).

## validation.md

# Subdir footprint status: validation

- New unit tests (gitstatus): argv pin, `findWorkTree`
  (root/subdir/nested/miss/worktree-file), prefix parse (strip,
  drop, collapsed at/under/above prefix, rename in/out of scope),
  real-git subdir `readGitStatus` (modified + added + untracked
  dir, out-of-scope change dropped).
- New server tests (footprint): ancestor-`.git` gate (scripted
  runner is called for a subdir root; members stamped from
  stripped rels); real-git subdir served root (`foot` on the
  edited building, `footAvailable` set, counts `+0 ~1 -0`-shaped).
- Regression: full `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green; existing e2e untouched
  (fixtures are tmpdir-based, still non-git).
- Live gate check: boot the floor on the gate session copy
  (`/tmp/artifex-gate-hrapp/internal/vacations`), read the first
  `/ws` snapshot, expect exactly the 3 `adapters/api` buildings
  footed `modified` and no others.
