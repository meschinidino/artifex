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
  `specs/2026-10-19-roadmap-slice/plan.md`,
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
