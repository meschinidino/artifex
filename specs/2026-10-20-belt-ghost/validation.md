# Ghost-default belts: validation

- New classifier unit tests (3 cases above); existing
  classifier + e2e isolation expectations green unchanged.
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check on the gate floor (screenshots): nothing-selected
  mid view reads quiet with live belts lit; selecting the
  8-outbelt file spotlights its routes (drawn ≥ 1, endpoints
  non-empty) where it read drawn 0 before.
