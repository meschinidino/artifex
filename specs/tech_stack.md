# Tech stack: Artifex

## Runtime

- **Bun + TypeScript (strict)** throughout: server, watcher, parser
  client, and tests. One Bun process (decision D14: five separate
  processes cannot fit the memory budget).
- **Zero production dependencies** except the parser grammars:
  `web-tree-sitter` + `tree-sitter-wasms` (TS/JS/TSX/JSX, Python,
  Java, Kotlin, Go).
  Dev-only: `bun-types`, `typescript`.

## Modules (`artifex/` root)

| Module | Role |
|---|---|
| `events/` | Shared event log: typed intent/observed events, stateless validator |
| `watcher/` | Repo listing (git-aware), live fs watching, secret masking |
| `parser/` | tree-sitter extraction in a short-lived subprocess per batch |
| `resolver/` | Import specifiers → repo files (tsconfig paths, Python packages, JVM FQNs, Go modules) |
| `connections/` | Literal-only endpoints/calls/tables/topics extraction + reachability graph |
| `agents/` | Agent dispatch adapters (`muse` today; ghost elicitation) |
| `server/` | Floor state, snapshot/patch over WebSocket, layout + event-log persistence, intent gate |
| `floor-ui/` | Canvas renderer (zones, machines, belts, ghosts), inspector, minimap, search |
| `e2e/` | Headless-Chromium floor tests over a fixture repo (`bun run e2e`) |
| `scripts/` | Headless ground-truth reports (`connections-report.ts`) |
| `spike/` | Measurement harness + results (agent capability matrix) |

## UI

- Server-rendered page + Canvas 2D, live state over a versioned
  WebSocket protocol (`snapshot` then `patch`; client resyncs on gaps).
- No framework and no separate build step for the user: the server
  bundles `floor-ui/app.ts` in a short-lived subprocess at boot and
  serves the result (a bundle failure fails boot loudly).
- Diag hooks (`__floor`, `__belts`, `__frames`) are a supported
  test surface for browser probes.

## Gates and budgets

- `bun test` — full unit suite; tests colocate with modules
  (`*.test.ts`). `bun run e2e` — browser suite over a fixture repo.
- `bun run typecheck` — strict `tsc --noEmit`, covers sources and tests.
- CI (`.github/workflows/e2e.yml`) runs the E2E suite on push/PR;
  unit, typecheck, and coverage are local gates, not in CI yet.
- Coverage bar: raw Bun function/line indicators ≥95 on both
  reporters; branch coverage recorded, not gated
  (`docs/coverage-reaudit.md`).
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
- Feature branches + PRs only (agreed 2026-10-14): `main` is
  branch-protected (PR required, 0 approvals, no force-push/delete),
  so direct pushes are rejected. No commit/push/PR without an
  explicit ask; review fixes stay uncommitted until the user says
  otherwise.
