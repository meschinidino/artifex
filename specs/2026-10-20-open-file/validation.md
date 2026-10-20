# Open-file view: validation

- New e2e test (expand → overlay text === pane text → Escape
  closes → reopen → scrim closes).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: screenshot of the open overlay on a MOD file.
