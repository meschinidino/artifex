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
