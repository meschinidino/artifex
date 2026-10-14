# Tech stack: Artifex

## Runtime

- **Bun + TypeScript (strict)** throughout: server, watcher, parser
  client, and tests. One Bun process (decision D14: five separate
  processes cannot fit the memory budget).
- **Zero production dependencies** except the parser grammars:
  `web-tree-sitter` + `tree-sitter-wasms` (TS/JS/TSX/JSX, Python).
  Dev-only: `bun-types`, `typescript`.

## Modules (`artifex/` root)

| Module | Role |
|---|---|
| `events/` | Shared event log: typed intent/observed events, stateless validator |
| `watcher/` | Repo listing (git-aware), live fs watching, secret masking |
| `parser/` | tree-sitter extraction in a short-lived subprocess per batch |
| `resolver/` | Import specifiers → repo files (TS self-ref/baseUrl/paths, Python roots) |
| `server/` | Floor state, snapshot/patch over WebSocket, layout persistence |
| `floor-ui/` | Canvas renderer (zones, machines, belts), inspector, minimap |
| `spike/` | Measurement harness + results (agent capability matrix) |

## UI

- Server-rendered page + Canvas 2D, live state over a versioned
  WebSocket protocol (`snapshot` then `patch`; client resyncs on gaps).
- No framework, no build step: static files served by the floor server.
- Diag hooks (`__floor`, `__belts`, `__frames`) are a supported
  test surface for browser probes.

## Gates and budgets

- `bun test` — full suite; tests colocate with modules (`*.test.ts`).
- `bun run typecheck` — strict `tsc --noEmit`, covers sources and tests.
- Pre-landing changes go through the review flow (adversarial +
  structured passes, QA probes) before commit.
- Budgets: 150 MiB server RSS, 60 fps floor interaction, 500 MB
  browser-tab fail threshold. Weak machine: the dev Mac itself
  (D14 builder gate inputs in `spike/RESULTS.md`).

## Conventions

- Text is truth: never render unproven state; errors and gaps are
  visible UI, not silent.
- Regression tests accompany behavior changes; red is demonstrated
  before the fix lands where feasible.
- No commit/push/PR without an explicit ask; review fixes stay
  uncommitted until the user says otherwise.
