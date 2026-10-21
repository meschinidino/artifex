# Belt click inspector: validation

- New wire unit tests (pair resolve, gone pair, multi-kind
  pair, unknown endpoint id).
- New server via tests (import lines, http method/path, topic
  name/handler, source-line text, truncation).
- New usages unit tests (Go strip/scan/alias/clause, TS
  statement shapes) + integration per language (Go/TS/Python/
  JVM-wildcard uses items).
- New e2e click test (deterministic via `hoverTarget` +
  setPointerCapture stub, mirroring the drag test).
- BCR5 e2e (incident belt keeps spotlight/selection/prompt) +
  unit tests for the incident predicate; progressive Escape
  pinned in the click test.
- BCR6 e2e (empty click deselects first, toggles only when
  clear; phase 1 proves the probe point every run).
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check: vacations floor, click a belt → edge card with
  endpoints + evidence; screenshot.
