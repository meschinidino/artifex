# 2026-10-19-contracts — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Declarative contract handlers v1 (SQL): requirements

Date: 2026-10-19. Implements `docs/ideas.md` "Declarative
contract handlers", v1 slice: SQL/table-reference contracts.
Design authority: the ideas item (literal-only, every fact
cites its line, dynamic stays unresolved), the existing
`connections/` honesty contract (`connections/types.ts`
header), and `specs/tech_stack.md` (zero new production
dependencies, strict typecheck, ≥95 raw coverage).

## Functional requirements

### Extractor: file selection

- FR1: `connectionsLang` returns `"sql"` for paths ending in
  `.sql` (lowercase match, the existing arms' precedent) and
  `extractConnections` dispatches them to `extractSql`. Any
  other SQL-bearing extension (`.ddl`, `.psql`, `.migration`)
  stays unextracted in v1.
- FR2: A `.sql` extraction returns `FileConnections` with
  `kinds: ["sql"]`, `declaredTables` and file-level
  `tables[]`; `endpoints`, `calls`, `topics`, `injections`,
  `methods`, `repoEntities` are empty and `className`,
  `entityName`, `entityTable`, `feign` are unset. `notes`
  carries dynamics only (FR9).

### Extractor: statement splitting and line honesty

- FR3: Statements split on `;` outside string literals
  (`'...'`, `"..."`, `` `...` ``, `$$...$$` and `$tag$...$
  tag$` dollar quotes) and outside `--`/`#` line comments
  and `/* ... */` block comments. A `;` inside any of those
  never splits.
- FR4: Every emitted fact cites the 1-based line of its own
  token: a `TableDecl` cites the line of the `CREATE TABLE`
  keywords (the `CREATE` token); a `TableUse` cites the line
  of its reference keyword (`FROM`/`JOIN`/`INTO`/`UPDATE`/
  `REFERENCES`); never the statement start, never line 0.
- FR5: Comment text and string-literal contents never yield
  facts: `-- CREATE TABLE fake`, `/* FROM t */`, and
  `'SELECT ... FROM fake'` inside a statement body produce
  no declaration and no use (adversarial fixtures pin this).

### Extractor: declarations

- FR6: `CREATE TABLE [IF NOT EXISTS] [TEMPORARY|TEMP|
  UNLOGGED] [schema.]name` (bare, double-quoted, backticked,
  or bracket-quoted `[name]`) emits one `TableDecl`:
  `table` is the unquoted name lowercased, `schema` the
  unquoted schema lowercased when present, `temporary: true`
  when a temp marker is present. `IF NOT EXISTS` changes
  nothing (still declares).
- FR7: `CREATE TABLE x AS SELECT ... FROM y` emits BOTH a
  `TableDecl` for `x` (line of `CREATE`) and `TableUse`
  entries for the statement's references (`y`, line of
  `FROM`). `SELECT ... INTO new_t FROM old_t` emits a use
  for `old_t` (`via: "sql-script"`, access `read`) and a
  use for `new_t` (`via: "ddl"`, access `write`): `INTO`
  creates without a `CREATE TABLE` token, so it is a use,
  not a declaration.
- FR8: `REFERENCES other_table` inside DDL (column or table
  constraint, incl. `FOREIGN KEY ... REFERENCES s.t`)
  emits a `TableUse` with `via: "ddl"`, access `unknown`,
  at the `REFERENCES` line. `ALTER TABLE x ...` emits a use
  for `x` (`via: "ddl"`, access `write`); other `ALTER`
  sub-references follow the keyword rules of FR10.

### Extractor: dynamics → notes

- FR9: Each of the following yields a `notes` entry naming
  the construct and 1-based line, and yields NO fact from
  the affected name: a `CREATE TABLE` whose name contains a
  placeholder (`${...}`, `:name`, `$n`, `%(name)s`);
  `EXECUTE` / `EXEC ...` statements; psql meta-commands
  (`\include`, `\i`, `\ir`, `\gexec`); references inside
  dollar-quoted function bodies (`CREATE FUNCTION` bodies
  are opaque in v1 — one note per body, not per inner
  token). Note format: `unresolved <construct> at line N`
  (the existing `unresolved ... at line N` precedent).

### Extractor: script references

- FR10: In non-`CREATE` statements, table references match
  the existing `SQL_TABLE_RE` keyword set (`FROM`, `JOIN`,
  `UPDATE`, `INTO`) plus `TABLE <name>` (bare-table
  statements) and `DELETE FROM <name>` (via `FROM`): each
  emits a file-level `TableUse` with `via: "sql-script"`,
  `derived: "explicit"`, access per the existing
  `sqlAccess`/INSERT-SELECT rules, at the keyword line.
  Stopwords follow the existing `SQL_STOPWORDS` set.
- FR11: `CREATE VIEW [schema.]v AS SELECT ... FROM t`
  emits a `TableDecl` for `v` (views occupy the table
  namespace for reachability) plus `TableUse` entries for
  the query's references, each with its own token line.
  `CREATE INDEX ... ON t ...` emits a use for `t`
  (`via: "ddl"`, access `unknown`); `DROP TABLE t` emits a
  use for `t` (`via: "ddl"`, access `write`).

### Graph join

- FR12: `buildConnectionGraph` builds a declared-table
  index over all repos' `.sql` files: normalized table name
  → every `{ repo, path, line, schema?, temporary? }`
  declarer, capped at 100 declarers per table (the
  topic-peers cap precedent). Multiple declarers are all
  listed; none is preferred.
- FR13: Every `TableRef` in endpoint closures
  (`methodTables`) and file closures (`fileTables`) carries
  `declaredBy` listing the declarers of its table, or an
  empty/omitted `declaredBy` when the table is undeclared
  in the indexed repos. Cross-repo fixpoint rounds preserve
  `declaredBy` (declarations are global facts, not
  round-dependent).
- FR14: Matching is lowercase-exact on the full dotted
  name: code/script reference `t` matches declarations of
  `t` (any schema or none); reference `s.t` matches ONLY
  declarations of `s.t`. An unqualified declaration never
  proves a schema-qualified reference.
- FR15: Totals gain `declaredTables` (distinct declared
  names across repos) and `undeclaredTables` (distinct
  referenced names with no declarer). Temporary-table
  declarations count as declarations.

### Surfacing

- FR16: `scripts/connections-report.ts` gains a tables
  section: one row per referenced table with rolled-up
  access and either `declared in <repo:><path>:<line>[,
  ...]` or the literal marker `undeclared`. (Exact row
  shape is an implementation choice; the declared/
  undeclared discrimination is normative.)
- FR17: The inspector's per-file tables list shows, per
  row, the declaration link (`<path>:<line>`, first
  declarer + `+N more` when several) where `declaredBy`
  is non-empty, and the literal marker `undeclared`
  otherwise. No new colors or layout primitives.

## Non-functional requirements

- NFR1 (honesty): no emitted declaration or use without a
  token line in the file; no placeholder-derived name in
  any fact; dynamics are counted in `notes`, never silent.
- NFR2 (purity): graph changes stay pure/no-I/O; the
  extractor stays a pure function of `(path, content)`.
- NFR3 (budgets): no new production dependencies; the
  `.sql` pass adds no subprocess and no measurable boot
  cost on repos without `.sql` files (dispatch-only).
- NFR4 (coverage): raw Bun function/line indicators stay
  ≥95 on both reporters after the slice.

## Acceptance criteria

- AC1: Given a migration tree with `CREATE TABLE users`,
  a Java entity mapping `users`, and a controller reaching
  it, the endpoint closure for that handler lists `users`
  with `declaredBy` naming the migration `path:line`,
  and the report row reads declared.
- AC2: Given a code reference to a table with no `CREATE
  TABLE` in any indexed repo, the closure carries empty
  `declaredBy`, the report row reads `undeclared`, and the
  inspector shows the `undeclared` marker — not a blank.
- AC3: Given adversarial SQL (table names in comments and
  string literals, `;` inside strings, placeholder DDL
  names, `EXECUTE`, dollar-quoted bodies), zero facts cite
  those tokens and every dynamic construct has a `notes`
  entry with its line.
- AC4: Given two migrations declaring `users` and a
  schema-qualified reference `app.users` with only an
  unqualified declaration, the join lists both declarers
  for `users` and marks `app.users` undeclared.
- AC5: `bun test`, `bun run typecheck`, `bun run e2e`
  green; coverage gate holds (NFR4); adversarial +
  structured review pass before landing.

## plan.md

# Declarative contract handlers (v1: SQL contracts): plan

Date: 2026-10-19. Specs `docs/ideas.md` "Declarative contract
handlers" as a first slice: SQL/table-reference contracts. The
ideas item names four contract families (SQL/table references,
OpenAPI specs, Protobuf/GraphQL schemas, Terraform); this spec
picks ONE for v1 (SQL) and names the rest as follow-ups.

## Objective

Extend the connections pass (`connections/`) beyond code imports
to declarative SQL contracts — `.sql` files (migrations, schema
dumps, seed scripts, views) — under the same honesty rules as the
existing pass: literal-only facts, every fact cites its 1-based
line, anything dynamic lands in `notes` as visibly unresolved and
never as a guessed fact. Two new proven edges:

1. **Table declarations**: `CREATE TABLE <name>` in a `.sql`
   file declares that table at `path:line`.
2. **Script table uses**: `FROM`/`JOIN`/`INTO`/`UPDATE` table
   references in `.sql` statements are `TableUse` facts (file
   level, `via: "sql-script"`), so migrations/views that read or
   write tables join the existing table index.

The graph then joins code-proven table uses (entity, native SQL,
JPQL, repository) against schema-declared tables: the inspector
and `connections-report` can show, per table, which `.sql` file
declares it — and, honestly, which code-referenced tables have
no declaration in the indexed repos.

## Scope

In scope:

- `connections/types.ts`: a `TableDecl` fact (`table`, `line`,
  optional `schema`, `temporary` flag); `FileConnections` gains
  `declaredTables: TableDecl[]`; `TableUse["via"]` gains
  `"sql-script"` and `"ddl"` (DDL-body references, e.g. foreign
  keys — exact set in `requirements.md`).
- `connections/extract.ts`: a literal-only `extractSql` pass for
  `.sql` files (see Architecture). Comment-aware, string-aware,
  statement-split line attribution.
- `connections/graph.ts`: a declared-table index
  (`table → declaring files`); per-table `declaredBy` on
  `TableRef` summaries; totals gain `declaredTables` and
  `undeclaredTables` counts. Pure, no I/O (existing module
  contract).
- `scripts/connections-report.ts`: report declared/undeclared
  tables (ground-truth surface for validation).
- Unit + fixture tests for the extractor and the graph join;
  coverage stays ≥95 raw on both axes.
- Inspector: per-table "declared in `path:line`" link where
  proven; undeclared tables render as `undeclared` (not as
  missing).

Out of scope:

- OpenAPI specs (endpoints declared in YAML/JSON, client
  generation joins) — follow-up F1.
- Protobuf / GraphQL schemas (message/type contracts,
  resolver joins) — follow-up F2.
- Terraform / infra contracts ("what does this actually
  expose") — follow-up F3, the ideas item's called-out edge.
- Non-`.sql` declarative SQL: embedded SQL in YAML/XML
  changelogs (Liquibase/Flyway XML), ORM mapping XML — later
  slices reuse the `extractSql` statement core.
- Stored-procedure bodies (`CREATE FUNCTION ... LANGUAGE
  plpgsql`): the `CREATE` line is a declaration fact only in
  v1; references inside the body are out (delimiter-sensitive,
  dialect-heavy).
- The T7 schema-view DB zone: this slice proves the facts the
  zone will render; the zone itself stays open per
  `specs/roadmap.md`.
- Cross-dialect SQL validation: the pass is literal pattern
  matching over proven tokens, not a parser per engine (no new
  production dependencies per `specs/tech_stack.md`).

## Proposed architecture

### Extractor (`connections/extract.ts`, additive)

- `connectionsLang` gains `"sql"` for `\.sql$` (case
  preserved; extension match is lowercase-only like the
  existing arms — `SCHEMA.SQL` stays unextracted, visibly,
  per the literal-only precedent).
- `extractConnections` dispatches `.sql` to a new
  `extractSql(path, content)` returning `FileConnections` with
  `kinds: ["sql"]`, `declaredTables`, file-level `tables[]`
  (`via: "sql-script"`), and `notes`. Endpoints/calls/topics/
  injections/methods stay empty: a script has no methods, so
  per-statement uses live at file level (the `tables[]`
  "direct tables only" contract already allows this).
- Statement splitting: split on `;` outside string literals
  (`'...'`, `"..."`, backticks, `$$...$$` dollar-quoted
  bodies) and outside line (`--`, `#`) and block (`/* */`)
  comments. Each statement keeps its start line; every fact
  cites the line of its own token (the `CREATE TABLE` token,
  the `FROM <table>` token), not the statement start.
- Reuse: the existing `SQL_TABLE_RE` + `sqlAccess` core
  (`extract.ts`) is the reference-token matcher for script
  statements, extended with `CREATE TABLE` declaration
  matching and comment/string stripping. `CREATE TABLE [IF
  NOT EXISTS] [schema.]name` (quoted or bare) yields a
  `TableDecl`; `TEMPORARY`/`TEMP`/`UNLOST` variants set the
  `temporary` flag and still declare (a temp table is a real
  name in that session — honesty means recording it, flagged,
  not dropping it).
- Dynamics → `notes`, never facts: `${...}` / `:name` /
  `$1`-style placeholders in DDL names, `EXECUTE` /
  `EXEC ...` dynamic DDL, `\include` / `\i` meta-commands,
  and dollar-quoted bodies are recorded as
  `unresolved ... at line N` (the `@Query`/topic precedent).
  A `CREATE TABLE` whose name is a placeholder declares
  nothing.

### Types (`connections/types.ts`, additive)

- `TableDecl = { table: string; line: number; schema?:
  string; temporary?: boolean }`. `table` is lowercase
  (the existing `sqlTables` normalization precedent);
  `schema` is kept as written, lowercased.
- `FileConnections.declaredTables: TableDecl[]` (empty for
  code files). `TableUse["via"]` gains `"sql-script"`
  (references in script statements) and `"ddl"` (references
  in DDL bodies, e.g. `REFERENCES other_table`).
- Wire/version impact: none — `FileConnections` is an
  internal contract; the floor wire carries summaries.

### Graph (`connections/graph.ts`, additive)

- Build a declared-table index: `table →
  [{ repo, path, line, schema?, temporary? }]` across all
  repos' `.sql` files. No disambiguation guessing: a table
  with several declarers lists all of them (cap 100, the
  topic-peers precedent).
- `TableRef` gains `declaredBy?: { repo: string; path:
  string; line: number }[]` (empty/omitted = undeclared in
  the indexed repos). Both `fileTables` (file closure) and
  `methodTables` (endpoint closure) attach it, so endpoint→
  table reachability answers "declared where" per hop.
- Totals gain `declaredTables` (distinct declared names)
  and `undeclaredTables` (distinct code/script-referenced
  names with no declarer). `directByFile` is unaffected
  (declarations are file-direct facts already).
- Matching rule: code table `t` matches declaration `t`
  case-insensitively after lowercase normalization; a
  schema-qualified code reference `s.t` matches declaration
  `s.t` only (an unqualified declaration of `t` does not
  prove `s.t` — same anti-guess rule as the service-name
  join).

### Report + inspector (surfacing)

- `scripts/connections-report.ts`: a tables section listing
  each referenced table with access roll-up and
  `declared in <path>:<line>` or `undeclared` — the
  headless ground-truth surface (`validation.md` MV/TC).
- Inspector: the existing per-file tables list gains the
  declaration link per row where proven; undeclared rows
  render an explicit `undeclared` marker. No new hues or
  layout (DESIGN.md tokens only).

## Steps

1. Types: add `TableDecl`, `declaredTables`, new `via`
   values. Red-first: extractor tests referencing the new
   shapes fail to compile.
2. Extractor: `extractSql` + statement splitter (string/
   comment aware) + `CREATE TABLE` / reference matchers;
   fixture tests per construct (declarations, quoted and
   schema-qualified names, temp tables, script SELECT/
   INSERT/UPDATE, views, FK references, placeholder/dollar-
   quoted/execute dynamics → notes, comment/string traps).
3. Graph: declared-table index, `declaredBy` attachment,
   matching rule, totals; join tests incl. multi-declarer,
   schema-qualified mismatch, and cross-repo declaration.
4. Report: declared/undeclared tables section.
5. Inspector: declaration links + `undeclared` markers.
6. Validation per `validation.md`; adversarial + structured
   review before landing (repo convention).

## Risks

- SQL dialect sprawl (backticks, brackets, dollar quotes,
  `#[...]`): the matcher must stay literal-token based and
  fail into `notes`, never into guessed facts. Mitigated by
  fixture tests per accepted construct and explicit
  unresolved fixtures per rejected one.
- Statement-split fidelity (a `;` inside a string/comment
  splitting a statement misattributes lines): every fact
  cites its token line, so a split error corrupts grouping,
  not line honesty — but grouping feeds access roll-up.
  Mitigated by splitter unit tests with adversarial `;`
  placement.
- `CREATE TABLE ... AS SELECT ...` and `SELECT ... INTO
  ...`: declaration and reference in one statement. Handled
  by emitting both facts with their own token lines
  (normative in `requirements.md`).
- Coverage gate: the splitter and matcher add branches;
  each needs direct tests (the trace-export precedent).

## Decisions

1. **SQL first.** Endpoint→table reachability already
   exists (`specs/roadmap.md` T7 note), so declarations
   join an existing proven index instead of building a new
   one. OpenAPI/GraphQL/Terraform each need a new index
   and new join semantics — bigger, later slices.
2. **`.sql` files only in v1.** Migration trees and schema
   dumps are the highest-density declarative table source;
   changelog XML/YAML and mapping files reuse the statement
   core later without changing the fact shapes.
3. **File-level script uses, no per-statement methods.**
   `.sql` scripts have no callable methods, so `methods[]`
   stays empty and uses live in `tables[]` (direct). A
   later slice may add per-statement provenance; the graph
   join does not need it.
4. **Temp tables declare, flagged.** Dropping them would
   silently undeclare names the script provably creates;
   the `temporary` flag keeps the fact honest.
5. **No declaration disambiguation.** Several `CREATE
   TABLE users` across migrations all declare; picking
   "the" one is exactly the guess this module must not
   make (the ambiguous-owner precedent in `buildConnectionGraph`).

## Follow-ups (not this slice)

- F1 OpenAPI: endpoints/paths declared in OpenAPI YAML/JSON
  joined against extracted code endpoints and calls.
- F2 Protobuf/GraphQL: message/type contracts and
  field-level joins (resolver → type, client → query).
- F3 Terraform: resource/exposure contracts ("what does
  this actually expose") — the ideas item's edge case,
  needs its own honesty rules for HCL interpolation.

## Assumptions (flagged per delegation)

- A1: `connections/extract.ts` (`sqlTables`, `SQL_TABLE_RE`,
  `sqlAccess`) and `connections/graph.ts` (TableSet,
  direct/file/method tables, totals) as read from this
  worktree are the design base; the slice is additive and
  assumes no concurrent refactor of those files.
- A2: `.sql` files reach the connections pass through the
  existing file-content pipeline (watcher listing +
  parse/content flow); if `.sql` is currently filtered
  from content loading, the threading step adapts without
  changing the fact shapes.
- A3: lowercase table normalization (existing `sqlTables`
  precedent) is acceptable for declarations; quoted
  case-sensitive identifiers are lowercased like code-side
  references, so both sides match under one rule.
- A4: no new production dependencies (tech-stack gate);
  matching stays regex/token based, no SQL grammar.

## validation.md

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
