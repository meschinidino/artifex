# Orientation readout: validation

- New layout unit tests (inside/outside/overlap-smallest/empty).
- New e2e test (chip === curb text after load).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: screenshot shows `vacations` chip + `◎ ADAPTERS`
  (or the landed zone); pan/zoom moves the readout.
