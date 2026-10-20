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
