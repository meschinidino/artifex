# 2026-10-20-gomod-belts — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Enclosing Go module belts: requirements

Date: 2026-10-20. Same family as `specs/2026-10-20-subdir-footprint.md`:
serving a subdir of a Go module silently drops every import belt,
because `go.mod` lives above the served root and all module imports
classify as external. The gate target (`hrapp/internal/vacations`)
has 10+ real in-scope imports and renders 0 belts.

## Requirements

- GMR1: When the served label root has no `go.mod` in-tree, the
  resolver consults the nearest enclosing `go.mod` above the root
  (walk up; the nearest one decides — a nearest go.mod with no
  `module` line, an unreadable file, or an oversize file ends the
  search with no enclosing module, never a farther module).
- GMR2: Enclosing-module imports map like in-tree ones, then
  relativize to the label root: the spec must fall under the
  root's module-relative prefix; targets outside the prefix are
  external (dropped, never guessed). In-tree modules (including
  nested) take precedence over the enclosing module.
- GMR3: Resolution stays pure: the context gains an optional
  `goEnclosing: { module, prefix }` (single nearest), computed by
  the server per label on every resolver-context rebuild. The
  enclosing go.mod itself is not watched (module renames need a
  reboot or wait for a context rebuild on other triggers).
- GMR4: Unchanged behavior when the label root holds its own
  go.mod (empty-prefix case needs no enclosing lookup), for
  non-Go repos, and for non-module Go trees (still external).

## Non-functional

- Same NFRs as the footprint slice: no new process/port/dep,
  status/resolve work off interactive paths, honesty (external
  stays external, never a guessed belt), coverage ≥95/95 both
  reporters, `WIRE_VERSION` 1.

## plan.md

# Enclosing Go module belts: plan

## Touch list

- `resolver/resolver.ts` (stays pure)
  - Export `parseGoModule` (existing `module` line parser).
  - `ResolverContext.goEnclosing?: { module: string; prefix: string }`.
  - `resolveGoSpecifier`: after in-tree modules miss, try the
    enclosing module (strip module, require the prefix,
    relativize to label-root dirs; outside-prefix = external).
- `watcher/scan.ts`
  - `findEnclosingGoModule(root)`: ancestor walk from the root's
    parent; nearest `go.mod` (≤256 KiB, readable) decides.
    Returns `{ module, prefix }` (POSIX prefix) or `undefined`.
- `server/index.ts`
  - `rebuildResolverContext`: per label, spread `goEnclosing`
    from the label root when set (root lookup via a
    label→root map next to `labelByRoot`).
- Tests: `resolver/resolver.test.ts` (enclosing mapping,
  precedence, out-of-scope, degenerate shapes),
  `watcher/watcher.test.ts` (walk: hit/miss/unreadable/garbage/
  oversize/nearness), one real-git real-floor server test
  (subdir of a Go module renders belts).

## Edge table

| Case | Result |
|---|---|
| Root go.mod in-tree | unchanged (enclosing ignored on hits) |
| Subdir of a module, in-scope import | belt to package non-test files |
| Import of a package outside the label root | external, no belt, no unresolved |
| Nearest go.mod garbage/unreadable/oversize | no enclosing (stop, don't look outward) |
| No go.mod anywhere above | external (as today) |
| Nested in-tree module + enclosing | in-tree wins |

## Not in scope

Python/JVM/TS out-of-root markers (same pattern, later);
watching the enclosing go.mod; e2e additions.

## validation.md

# Enclosing Go module belts: validation

- New resolver unit tests (enclosing first-hit, precedence over
  in-tree miss, out-of-scope external, spec==module, rest==prefix,
  no-enclosing unchanged).
- New scan unit tests (nearest wins, miss, garbage/unreadable/
  oversize stop, sub-prefix computation, root-itself not consulted).
- New server test: served subdir of a Go module reports belts for
  an in-scope import and none for an outside-prefix import.
- Regression: `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live gate check: `/tmp/gate-belts.ts` on the session copy
  reports belts > 0 (spot-check one adapters→domain edge) with
  the running floor restarted on the fixed code.
