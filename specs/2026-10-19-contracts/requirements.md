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
