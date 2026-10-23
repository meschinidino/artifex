# 2026-10-19-trace-export — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Structural trace export: requirements

Date: 2026-10-19. Implements `docs/ideas.md` "Structural trace
export". Design authority: the ideas item (compact markdown,
`path:line` anchors, no source; inspector + agent interface fit),
T5 v1 contract (`agent-interface/`, parent checkout), D18 safety
(masking/rendering boundary), D4 one-meaning encodings, and
`DESIGN.md` (Operate chrome, mono paths, tokens only).

## Functional requirements

### Export format (normative)

- FR1: The export is UTF-8 markdown, LF line endings, one fixed
  section order: header, `## imports`, `## imported by`,
  `## endpoints`, `## calls out`, `## tables`, `## topics`,
  `## unresolved`. Renderers and tests match this order exactly.
- FR2: The header is exactly two lines:
  `# trace: <path>` then `floor: <repo>`.
  `<repo>` is the floor repo label ("" renders as `(single)`).
  No timestamps, no versions, no trailing whitespace.
- FR3: `## imports (N)` lists the file's own resolved in-repo
  imports, one per line, `- <target>:<line>`, where `<line>` is
  the 1-based line of the import statement in the exporting
  file. Sorted bytewise by target. Targets proven only through
  JVM type use (same-package or wildcard-resolved, which carry
  no import statement line) render instead as
  `- <target> (type use, no import line)` and count toward N —
  a file whose every edge is unlined never prints a false
  `none` while the belts show edges (NFR3). When N is 0 the
  section body is the single line `none`. When the file's own
  imports are unproven (parse `error`/`unparsed`, or binary),
  the body is instead the single line
  `unproven (<reason>)` with reason one of `parse-error`,
  `unparsed`, `binary` — never an empty claim of zero imports.
- FR4: `## imported by (M)` lists dependents, one per line,
  `- <dependent-path>:<line>`, where `<line>` is the import
  statement's line in the dependent file. Sorted bytewise by
  path. Dependents proven only through type use render as
  `- <dependent-path> (type use, no import line)` and count
  toward M. M=0 renders `none`.
- FR5: `## endpoints (K)` lists served endpoints, one per line:
  `- <METHOD> <route> <path>:<line> → <handler>[ → tables: <t> (<access>)[, …]]`
  (the tables suffix is omitted when the endpoint reaches no
  proven table; `<path>` is the exporting file). Caller lines
  follow, one per line, indented two spaces:
  `  ← <caller-path>:<line> <caller> (<via>)`.
  Sorted by route, then method. K=0 renders `none`. Routes
  render without query strings or fragments (`?...`/`#...` and
  their values never appear); secret-bearing `name=value`
  segments mask to `name=[masked]` (D18, NFR4).
- FR6: `## calls out (C)` lists outgoing endpoint calls, one per
  line:
  `- <METHOD> <path> <file>:<line> (<via>[, <caller>]) → <dest>`
  where `<dest>` is a matched file path, `<service> (not in
  indexed repos)`, or `unresolved`. Sorted by path, then line.
  C=0 renders `none`. Call paths sanitize like routes
  (query/fragment stripped, secret pairs masked).
- FR7: `## tables (T)` lists directly-used tables, one per line:
  `- <table> <access> via <via> through <through>[ (implicit name)]`.
  Sorted bytewise by table. T=0 renders `none`. (Transitive
  reachability stays in the inspector; the export lists direct
  use only — compact over complete.)
- FR8: `## topics (P)` lists topic uses, one per line:
  `- <topic> <direction>[ (<handler>)][ · peers: <a>, <b>]`.
  Sorted bytewise by topic. P=0 renders `none`.
- FR9: `## unresolved` renders only when something is
  unresolved, as count lines (each present only when nonzero):
  `<n> unresolved import(s)`, `<m> dynamic connection(s) not
  guessed`. When both are zero the whole section is omitted
  (it is the only omissible section).
- FR10: Per-section cap: at most 50 entries; overflow appends
  `+N more` as the section's last line (counts stay truthful).
  Total cap 32 KiB: the formatter stops at a section boundary
  and appends `… truncated (N of M sections)` as the final line
  rather than cutting a row. Both caps are covered by tests
  with multi-entry fixtures.
- FR11: No source in the output. The emitted vocabulary is
  restricted to: file paths, line numbers, counts, HTTP
  methods, routes, handler/caller/method names, table/topic
  names, access/via/direction labels, service names, and the
  fixed headings/markers above. A test asserts over fixtures
  that no output line carries statement text beyond these
  tokens (e.g. an `import { x } from` line must appear only as
  its target path + line). Every source-derived string is
  untrusted repo content: mid-line markdown metacharacters
  render backslash-escaped, so no path, route, handler, table,
  or topic can inject markdown structure or extra lines;
  entries carrying control characters are dropped (counts
  reflect rendered entries), while the header path and repo
  label substitute U+FFFD instead — the export names its file
  or it names nothing. Property tests assert line structure
  holds over generated hostile strings.
- FR12: Determinism: the same input facts produce byte-identical
  output on every call (no timestamps, no map-iteration order
  leaks — all lists sorted). Tested by double-format equality.

### Worked example (informative, pinned by a test)

```md
# trace: shop/OrderController.java
floor: (single)
## imports (2)
- shop/OrderService.java:3
- shop/model/Order.java:4
## imported by (1)
- shop/AdminController.java:5
## endpoints (1)
- GET /api/shop/order/{id} shop/OrderController.java:7 → byId → tables: orders (read)
  ← sender:shop/OrderClient.java:4 byId (feign)
## calls out (0)
none
## tables (1)
- orders read via entity through OrderController
## topics (0)
none
## unresolved
1 unresolved import(s)
```

### Agent interface

- FR13: `floor.getTrace` takes `{path}` (non-empty string) and
  returns `{path, markdown}`. Unknown path returns the T5
  `unknown-building` invalid-params error with the same message
  shape as `floor.getBuilding`. Missing/empty `path` and
  non-object `params` reuse the existing `getBuilding` invalid
  params errors. Auth, body caps, and envelope versioning are
  unchanged from `protocol.ts` (`AGENT_API_VERSION` stays 1).
- FR14: `floor.getTrace` is read-only: it writes no store,
  emits no event, and changes no wire state. Tested by
  asserting the notes/event counts are identical before and
  after a call.

### Inspector button

- FR15: The inspector body shows a "Copy trace" default button
  after the definition list and before the connection sections
  whenever a building is selected. One click sends
  `{v:1, type:"export-trace", path}` for the selected path; the
  button disables while the request is in flight and re-enables
  on response.
- FR16: On `{v:1, type:"trace", path, markdown}` matching the
  current selection, the client writes the markdown to the
  clipboard and shows a transient confirmation in
  `#status-notice` (`Trace copied: <path>`). A response for a
  no-longer-selected path is dropped silently (the preview-stale
  precedent).
- FR17: Clipboard failure (rejected write, missing API, insecure
  context) reveals the markdown in a readonly inspector `<pre>`
  with a visible manual-copy affordance ("Select all" focus on
  open); the notice names the fallback
  (`Clipboard unavailable — copy from below`). Never a silent
  no-op. Server `not-found` errors surface through the existing
  notice path with the unknown path named.
- FR18: Button and fallback use existing tokens/components only
  (default `.btn`, mono `<pre>`): no new hues, square corners,
  standard focus ring and press physics per `DESIGN.md`. The
  fallback `<pre>` stamps via `textContent` only.

### Parser import lines

- FR19: Every emitted `ImportRef` carries `line: number`, the
  1-based line of the import statement's first token. The codec
  rejects import refs without an integer line ≥ 1 (fail closed,
  same as malformed messages today).
- FR20: Fixture tests per language (TS/TSX, Python, Java,
  Kotlin, Go) pin exact lines for imports at non-1 lines and
  for multi-line import statements (statement-start line).
  Dynamic/skipped forms still emit nothing (no change).

## Non-functional requirements

- NFR1: No new process, port, or production dependency (D14;
  one Bun process, 150 MiB budget). The formatter is a pure
  in-process module; `trace/` ships no runtime imports beyond
  types.
- NFR2: Export latency is linear in the exporting file's own
  facts plus one linear pass over the import map for dependent
  inversion (the T5 `getBuilding` precedent — no new index to
  keep consistent). No per-frame or per-keystroke work: the
  export runs only on explicit request.
- NFR3: Honesty rules carry over: `unproven (...)` instead of
  guessed imports, `not-found`/`unknown-building` instead of
  empty exports, `+N more`/truncation markers instead of silent
  cuts, `schemaZoneBuilt`-style scoping where reused
  (`getDbSchema` aggregation is not re-exposed here).
- NFR4: Safety (D18): the export contains structural facts only
  (FR11), so there is no new secret-bearing surface; handler /
  table / topic strings render in the fallback `<pre>` via
  `textContent` only, same as all file-derived content. Route
  and call-path values render without query strings or
  fragments, and secret-bearing `name=value` segments mask to
  `[masked]` (FR5/FR6).
- NFR5: Coverage stays ≥95 raw function/line on both Bun
  reporters (CI gate); branch coverage recorded, not gated.
  New UI DOM code follows the existing e2e-covered pattern.
- NFR6: `WIRE_VERSION`, `AGENT_API_VERSION`, and
  `PARSER_PROTOCOL_VERSION` all stay 1 (additive changes, both
  sides ship together).

## Acceptance criteria

- AC1: On the connections fixture repo, the inspector "Copy
  trace" button for a controller file yields markdown matching
  FR1–FR12 (byte-compared against the pinned example shape,
  modulo fixture paths), containing `path:line` anchors for
  every import, dependent, endpoint, caller, and call.
- AC2: `curl`ing `floor.getTrace` with the token-file bootstrap
  returns the identical markdown string the inspector copies
  for the same path (single formatter, both surfaces).
- AC3: Unknown path errors name the path on both surfaces
  (`unknown-building` over `/agent`, `not-found` notice in the
  UI); unparsed and binary fixtures export with `unproven (...)`
  own-imports while still listing dependents.
- AC4: Clipboard-blocked browser run (permissions revoked)
  delivers the text through the manual-copy fallback with the
  naming notice; zero console errors throughout.
- AC5: `bun test`, `bun run typecheck`, `bun run e2e`, and the
  extended comfort script all pass; coverage gate holds.

## plan.md

# Structural trace export: plan

Date: 2026-10-19. Specs `docs/ideas.md` "Structural trace export"
as a small complete slice on top of the T5 agent interface (parent
checkout, uncommitted at spec time — see Assumptions).

## Objective

One-click export of a file's structural neighborhood — imports,
importers, endpoint callers, calls out, endpoint/table links — as
compact markdown with `path:line` anchors and no source code, for
agent context. Two surfaces: a "Copy trace" button in the inspector
panel, and a `floor.getTrace` read query on the T5 agent interface.
One pure formatter serves both.

## Scope

In scope:

- Parser: a proven 1-based `line` on every `ImportRef` variant
  (import statement's line), with per-language fixture tests.
- Server: carry import lines from parse results through resolution
  into the per-request model; new WS `export-trace` request /
  `trace` response; new `floor.getTrace` agent method.
- New pure module `trace/format.ts`: `formatTrace(model) → string`,
  the single markdown builder for both surfaces.
- Inspector: "Copy trace" button for the selected building,
  clipboard write with a visible-manual-copy fallback, transient
  confirmation.
- `scripts/agent-comfort.ts` gains a `getTrace` leg (read-back +
  no-source spot check).
- Unit + integration tests for all new behavior; e2e for the button
  round trip and the fallback; coverage stays ≥95 raw on both axes.

Out of scope:

- Symbol-level export (per-method trace of callers/callees through
  JVM field-receiver chains): `methods[]` is already extracted but
  no method-level index exists; this slice exports file
  neighborhoods only. The endpoint `handler`/`caller` names with
  lines inside the export are the v1 symbol anchors.
- Source inclusion of any kind: the export cites structure only.
  Path/basename/handler/table/topic strings are structural facts,
  not source.
- Why-notes, recent changes, test state in the export: structure
  only (see Decision 3).
- T6 ask-why, T7 schema-view zone, Replay Theater (P3).
- MCP stdio/SSE transport, per-agent tokens, a second port or
  process (D14), file writes through the interface.
- Full D17 inspector retitle (Why/Changes/Structure/Health): the
  button joins the existing inspector without restructuring it.
- Import-line display anywhere else (inspector rows, belts view):
  lines ship only inside the export in this slice.

## Proposed architecture

### Parser (`parser/`, protocol v1 additive)

- `ImportRef` gains `line: number` on all four variants (ts, py,
  jvm, go): the 1-based line of the import statement's first
  token, taken from the tree-sitter node start position at
  extraction time. `PARSER_PROTOCOL_VERSION` stays 1: both sides
  ship together and the codec requires the field (malformed
  messages still fail closed).
- `parser/extract.ts`: record the line where each literal import
  node is accepted. Fixture tests per language pin exact lines,
  including multi-line import statements (line of the statement
  start).

### Server model (extends the T5 `QueryModel`)

- The server already retains per-file resolved import targets
  (T5 plan: `imports: Map<path, string[]>`). That map becomes
  `Map<path, { target: string; line: number }[]>` (name:
  `importLines`; exact shape is an implementation choice, the
  contract is target+line per importing file).
- Dependents-with-lines derive from the same map by inversion:
  for target P, every importer D contributes `D:line`. No new
  stored index; inversion cost is linear per request over the
  import map, same as T5's `getBuilding` today.
- Unparsed/binary/error files export honestly: own imports
  unknown ("imports: unparsed …" line naming the cause), while
  dependents and connection summaries still render — they are
  proven by other files' facts, not by parsing this one.

### Formatter (`trace/format.ts`, pure)

- `formatTrace(input: TraceInput) → string`, where `TraceInput`
  is file identity + sorted import/call/dependent/connection
  facts (assembled by the server for WS and agent paths alike).
  Pure: deterministic output for a given input, no clock reads
  (no timestamps in the markdown — output must be diff-stable),
  no I/O.
- Section order (fixed): header, imports, imported-by, endpoints,
  calls-out, tables, topics, unresolved. Empty sections render as
  `none` one-liners except unresolved, which renders counts only
  when nonzero and is omitted when zero. Exact format is
  normative in `requirements.md`.
- Caps: 50 entries per section, overflow as `+N more` (the
  search-list precedent). Total output cap 32 KiB: the formatter
  truncates at a section boundary with a `truncated` marker line
  rather than mid-row. Sorting is bytewise by path within
  sections (the T5 `byPath` precedent).
- No-source property: output vocabulary is restricted to paths,
  line numbers, counts, HTTP methods, routes, handler/caller
  names, table/topic names, access/via labels, and fixed
  headings. Unit tests assert this over fixtures (no emitted
  line equals any source line of the fixture beyond the
  structural tokens).

### Agent interface (`agent-interface/`, additive)

- `floor.getTrace {path}` → `{path, markdown}`. Param validation,
  auth, and envelope errors follow the existing `floor.getBuilding`
  path exactly (`unknown-building` reuses the same message).
  Read-only: no store writes, no events emitted.
- `AGENT_API_VERSION` stays 1 (additive method, both sides ship
  together).

### WS wire (`floor-ui/wire.ts`, additive, `WIRE_VERSION` stays 1)

- Client → server: `{v:1, type:"export-trace", path}`.
- Server → client: `{v:1, type:"trace", path, markdown}` on
  success; the existing `{v:1, type:"error", code, message}`
  with `not-found` for an unknown path (the `open-file` error
  precedent). Stale responses (selection moved on) are dropped
  by path match, the preview-stale precedent.

### UI (`floor-ui/`)

- `index.html`: a "Copy trace" default button in the inspector
  body, after the definition list, before the connection
  sections. Disabled while no building is selected (inspector
  body hidden covers this) and while a request is in flight.
- `app.ts`: click → send `export-trace` → on `trace`,
  `navigator.clipboard.writeText(markdown)` → transient
  confirmation in `#status-notice` ("Trace copied: <path>").
  On clipboard failure (or insecure context): reveal the
  markdown in a readonly `<pre>` with visible "select all"
  affordance for manual copy — never a silent no-op.
- `styles.css`: existing tokens only (default `.btn`, mono
  `.pre` treatment); no new hues. The button is Operate chrome,
  square, with the standard focus ring and press physics.

## Steps

1. Parser: add `line` to `ImportRef` + codec, record in
   `extract.ts`, fixtures per language (ts/tsx, py, java,
   kotlin, go) incl. multi-line imports. Red-first where the
   extractor currently drops position info.
2. Server: thread import lines into the resolved-import store,
   extend the T5 `QueryModel` assembly, add the WS
   `export-trace`/`trace` path and `floor.getTrace` dispatch.
3. `trace/format.ts` + `trace/format.test.ts`: formatter with
   normative-format tests, cap/overflow tests, no-source
   property tests, deterministic-ordering tests.
4. UI: button, WS round trip, clipboard + fallback, confirmation;
   e2e for the round trip and fallback visibility.
5. Comfort script: `getTrace` leg with honesty asserts.
6. Validation per `validation.md`; adversarial + structured
   review before landing (repo convention).

## Risks

- Clipboard writes after an async WS hop: `writeText` generally
  succeeds in a focused tab, but behavior varies by browser and
  context. Mitigated by the specified manual-copy fallback,
  which is itself e2e-asserted — the feature never depends on
  clipboard permission to deliver the text.
- Parser line fidelity across six grammars: each extractor walk
  must take the statement start, not a child token. Mitigated
  by per-language fixtures with imports at known, non-1 lines
  and multi-line forms.
- Coverage gate: new server branches (WS route, dispatch case)
  and the formatter need direct tests; DOM stamping stays
  minimal (existing e2e pattern covers it).
- T5 drift: this spec builds on uncommitted T5 code. If T5 lands
  with a different `QueryModel` or envelope shape, the
  trace-input assembly and method wiring follow T5 as landed;
  the formatter contract and markdown format are unaffected.

## Decisions

1. **File-level v1, no per-symbol entry point.** The ideas item
   says "file or symbol's neighborhood". Symbol-granular export
   needs a method-level index plus a selection affordance that
   does not exist; file-level export with handler/caller symbol
   names and lines inside is the small complete slice. A later
   slice can add `floor.getTrace {path, symbol}` over the
   already-extracted `methods[]`.
2. **Server formats, client copies.** The alternative (ship
   import lines over the wire, format in the browser) duplicates
   the formatter across two runtimes and grows every snapshot
   for a one-click action. One server formatter serves both
   surfaces; the WS response carries the finished markdown.
3. **Structure only: no notes, changes, or test state.** Notes
   are user text (masking + escaping surface for zero structural
   value); changes and test state are status, not structure.
   The ideas item enumerates imports, importers, callers,
   callees, endpoint/table links — the export covers exactly
   that set.
4. **Deterministic, timestamp-free output.** No `generated at`
   line: two exports of an unchanged floor must diff empty, so
   agents can cache and humans can compare. Staleness is the
   caller's context (floor `stateVersion` is already visible in
   the UI and queries), not the artifact's.
5. **`floor.getTrace` naming.** Follows the T5 `floor.get*`
   read-query family (`getBuilding`, `getPlan`, `getDbSchema`).
   It is a read despite returning a rendering — no state
   changes, no events.

## Assumptions (flagged per delegation)

- A1: all four parent reference files were readable from this
  worktree and are taken as the T5 design of record:
  `specs/2026-10-19-roadmap-slice.md`,
  `agent-interface/queries.ts`, `agent-interface/protocol.ts`,
  and the Why section of `floor-ui/machines.ts`
  (`whyNoteSection`). No fallback to the design doc was needed.
- A2: the T5 slice lands before this one (or with it) with the
  shape in A1: `POST /agent` JSON-RPC, `QueryModel` with
  per-file resolved imports + `conns`, `notes` on the wire.
  Trace wiring follows T5-as-landed if it differs.
- A3: the server retains per-file resolved import lists at
  request time (T5 plan §queries). Import-line threading
  extends that store; if the landed store shape differs, the
  assembly step adapts without changing the formatter.
- A4: tree-sitter nodes in `parser/extract.ts` expose start
  positions usable for 1-based line derivation in all six
  grammars (standard API; pinned per language by the new
  fixtures — a grammar that cannot prove a line fails its
  fixture loudly rather than emitting line 0).
- A5: `navigator.clipboard.writeText` availability varies;
  the fallback path (not the clipboard API) is the guaranteed
  delivery mechanism.

## validation.md

# Structural trace export: validation

Date: 2026-10-19. Run after implementation; all boxes must check
before the slice lands. Pre-landing changes go through
adversarial + structured review per repo convention.

## Manual validation

- MV1 (button): Boot the floor on the connections fixture repo,
  select a controller file, click "Copy trace". Confirm the
  notice reads `Trace copied: <path>` and the clipboard holds
  markdown matching the FR1–FR12 shape (header, all eight
  sections in order, `path:line` anchors on imports,
  dependents, endpoints, callers, calls).
- MV2 (fallback): Revoke clipboard permission (or run over an
  insecure context), click "Copy trace". Confirm the readonly
  `<pre>` appears in the inspector with the full markdown, the
  notice reads `Clipboard unavailable — copy from below`, and
  manual select-all/copy delivers the text.
- MV3 (agent): With the server running, run the token-file curl
  from the T5 connect snippet against `floor.getTrace` for the
  same path as MV1. Confirm byte-identical markdown to the
  clipboard result (diff empty).
- MV4 (errors): `floor.getTrace` for a nonexistent path returns
  the `unknown-building` envelope error naming the path; in the
  UI, an `export-trace` race (select file B before A's trace
  returns) drops A's response without touching the clipboard or
  the notice.
- MV5 (honesty): Select an unparsed file (oversize or
  grammar-missing fixture) and a binary file. Confirm the
  export shows `unproven (unparsed)` / `unproven (binary)` for
  own imports while still listing true dependents; confirm a
  JVM file whose edges resolve only through wildcard or
  same-package type use shows `(type use, no import line)` rows
  instead of `none`; confirm a >50-dependent fixture shows
  `+N more` with a truthful count.
- MV6 (no source): Eyeball one export against the file: no
  statement text, no string literals, no comments appear —
  only the FR11 vocabulary. Routes and call paths render
  without query strings or fragments, secret-bearing pairs
  masked; markdown metacharacters in names render escaped.

## Technical checks

- TC1: `bun test` — full suite green (parser, resolver, server,
  agent-interface, trace, floor-ui pure modules).
- TC2: `bun run typecheck` — strict `tsc --noEmit` clean.
- TC3: `bun run e2e` — browser suite green incl. the new
  button round-trip and fallback tests; zero console errors
  after every test (existing harness rule).
- TC4: `bun run scripts/agent-comfort.ts --repo <dir> --port
  <port>` — extended trial green incl. the `getTrace` leg
  (read-back equality, unknown-path error, masked-secret
  fixture unaffected).
- TC5: Coverage gate holds — raw Bun function/line indicators
  ≥95 on both reporters (`scripts/coverage-gate.sh` as in CI);
  branch coverage recorded in the PR notes, not gated.
- TC6: No hardcoded hex in new UI code (`grep` new styles/DOM
  for `#[0-9a-f]` outside token definitions); no new hues,
  square button, focus ring present (DESIGN.md spot check).
- TC7: Determinism probe — call `floor.getTrace` twice for one
  path with no floor activity between; `diff` of the two
  responses is empty.

## Expected unit / integration tests

- `parser/parser.test.ts` (or per-language fixtures): exact
  import lines incl. non-1 lines and multi-line statements for
  TS/TSX, Python, Java, Kotlin, Go; codec rejects line-less /
  line-0 import refs.
- `trace/format.test.ts`: pinned worked-example test
  (byte-exact); section order; `none` bodies; `unproven (...)`
  reasons; sorting within sections; 50-entry `+N more`;
  32 KiB section-boundary truncation with the marker line;
  unresolved-section omission when zero; double-format
  determinism; no-source property over fixtures; unlined
  `(type use, no import line)` rows counting toward totals;
  query/fragment stripping and secret-pair masking;
  markdown-escaping and control-char drops; adversarial
  line-structure property tests.
- `agent-interface/protocol.test.ts`: `floor.getTrace` success
  shape, unknown path, empty/missing path, non-object params,
  bad auth, read-only (stores unchanged across the call).
- `agent-interface/queries.test.ts` (or server model tests):
  dependents-with-lines inversion incl. empty map and
  self-import exclusion; unparsed/binary model assembly;
  unlined type-use edges in both directions; direct-only
  tables from pre-merge facts (merged access never leaks).
- `connections/graph.test.ts`: `directByFile` keeps the file's
  own access (direct read + injected write stays read).
- `server/server.test.ts`: WS `export-trace` round trip incl.
  `not-found` for unknown paths; no version bumps asserted
  (`WIRE_VERSION`/`AGENT_API_VERSION` still 1).
- `floor-ui` pure tests (where the button state helper lives,
  if any): in-flight disable/enable transitions.
- `e2e/floor.test.ts`: button presence + click → `trace`
  round trip observed via diag/probe; fallback `<pre>`
  visibility when clipboard writes are blocked; transient
  confirmation text; zero console errors.

## Closure criteria

- All MV/TC boxes checked with evidence (clipboard diff, curl
  transcript, gate numbers) quoted in the landing PR.
- New tests carry `Value:` comments per repo convention;
  residuals (if any) named in `docs/coverage-reaudit.md`.
- Adversarial + structured review passes recorded; review
  fixes stay uncommitted until the user says otherwise.
- `docs/ideas.md` item marked as specified/shipped (link this
  spec dir); roadmap/TODOS updated only if the builder moves
  the item into scheduled work.
