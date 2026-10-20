# Footprint diff contents: validation

- New server unit tests (modified hunks + counts, untracked flag,
  clean empty, non-git undefined, 120-line cap + truncated).
- New WS round-trip test (modified file over a real server).
- New e2e test (trio `src/a.ts` shows `-1`/`+2` hunk lines).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: MOD file inspector shows Changes `+N −M` with the
  sorting hunks; untracked file shows the new-file line.
