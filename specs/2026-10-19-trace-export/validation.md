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
