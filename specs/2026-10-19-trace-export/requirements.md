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
