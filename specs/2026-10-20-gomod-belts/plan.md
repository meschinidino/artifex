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
