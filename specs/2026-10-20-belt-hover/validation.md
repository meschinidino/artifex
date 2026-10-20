# Belt hover-trace: validation

- New route unit tests (closest/first-wins-ties/past-max/empty/
  degenerate zero-length segment).
- New e2e hover test (deterministic via `hoverTarget`).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: screenshot with a hovered route dispatched at
  `hoverTarget` shows the ivory trace + pointer cursor.
