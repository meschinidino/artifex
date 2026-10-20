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
