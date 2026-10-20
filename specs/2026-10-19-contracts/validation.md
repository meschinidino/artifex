# Declarative contract handlers v1 (SQL): validation

Date: 2026-10-19. Run after implementation; all boxes must
check before the slice lands. Pre-landing changes go through
adversarial + structured review per repo convention.

## Manual validation

- MV1 (declared join): Boot the floor on a fixture repo with
  a migration `CREATE TABLE users` (known line), a JPA
  entity mapping `users`, and a controller reaching it.
  Select the controller: confirm the endpoint's tables list
  shows `users` with `declared in <migration-path>:<line>`.
  Run `scripts/connections-report.ts` and confirm the
  `users` row reads declared with the same `path:line`.
- MV2 (undeclared honesty): Reference a table with no
  `CREATE TABLE` anywhere indexed. Confirm the inspector
  row shows the literal `undeclared` marker and the report
  row reads `undeclared` — not blank, not a guessed file.
- MV3 (multi-declarer + schema): With two migrations
  declaring `users` and a schema-qualified reference
  `app.users` (unqualified declaration only), confirm the
  join lists both declarers for `users` (`+1 more` in the
  inspector) and marks `app.users` undeclared.
- MV4 (dynamics visible): Open a `.sql` file with a
  placeholder-named `CREATE TABLE`, an `EXECUTE`, and a
  dollar-quoted function body. Confirm no declaration or
  use facts come from those constructs and each has an
  `unresolved ... at line N` note with the true line.
- MV5 (comment/string traps): Eyeball one extraction
  against a fixture holding `CREATE TABLE`/`FROM` tokens
  inside `--`/`/* */` comments and string literals plus a
  `;` inside a string. Confirm zero facts cite those
  tokens and surrounding real facts keep true lines.

## Technical checks

- TC1: `bun test` — full suite green (connections,
  graph, server, report, floor-ui pure modules).
- TC2: `bun run typecheck` — strict `tsc --noEmit` clean.
- TC3: `bun run e2e` — browser suite green incl. any new
  inspector-declaration test; zero console errors after
  every test (existing harness rule).
- TC4: coverage — raw Bun function/line indicators ≥95 on
  both reporters (existing gate script).
- TC5: ground-truth diff — on the validation repo, every
  `TableDecl` in the report matches a `grep -n -i
  'create table'` hit (same file, same line, same table),
  and every `undeclared` row has no such hit in any
  indexed `.sql` file. False positives fail the slice.

## Tests (required with the slice)

- T1 extractor fixtures: declarations (bare, quoted ×3
  styles, schema-qualified, `IF NOT EXISTS`, temp
  variants), `CTAS`, `SELECT INTO`, views, indexes,
  `ALTER`/`DROP`, FK `REFERENCES`, script SELECT/INSERT/
  UPDATE/DELETE with access roll-up — each pinning exact
  1-based lines.
- T2 dynamics fixtures: one per FR9 construct asserting
  zero facts + one `notes` entry with the true line.
- T3 trap fixtures: comment/string `;` splitting,
  comment/string keyword tokens (FR3/FR5) — zero facts
  from traps, true lines around them.
- T4 graph join: multi-declarer listing + cap, schema
  mismatch (FR14), cross-repo declaration, `declaredBy`
  preserved through fixpoint rounds, totals
  (`declaredTables`/`undeclaredTables`).
- T5 report/inspector: declared vs `undeclared` row
  rendering; `+N more` overflow; empty-`declaredBy`
  never renders a link.

## Closure

- All MV/TC boxes checked with observed evidence (paths,
  lines, command outputs quoted in the landing report).
- Residuals (dialect constructs found but deliberately
  unresolved) named in the landing notes, not silent.
- Follow-ups F1–F3 (OpenAPI, Protobuf/GraphQL, Terraform)
  filed as spec-needed ideas items if not already tracked.
