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
