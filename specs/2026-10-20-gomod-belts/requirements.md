# Enclosing Go module belts: requirements

Date: 2026-10-20. Same family as `specs/2026-10-20-subdir-footprint/`:
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
