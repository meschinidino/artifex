# T5 — Agent interface: requirements

Date: 2026-10-19. Slice spec in `specs/2026-10-19-roadmap-slice/`
(plan.md, validation.md). Design authority:
`docs/designs/artifex-ghost-factory.md` v1 contract + D18/D19.

## FR1 — Agent endpoint

- `POST /agent` accepts `{method, params?, id?}` with
  `Content-Type: application/json` and
  `Authorization: Bearer <launch-token>`.
- Responses are `{v:1, id, result}` or
  `{v:1, id, error:{code, message}}`, `id` echoed (null when the
  request had none or never parsed).
- Error codes: -32601 unknown method, -32602 invalid params,
  -32001 bad auth. HTTP: 200 envelope errors, 401 bad auth, 400
  non-JSON body, 413 body over 64 KiB. `GET /agent` → 405.
- Host/Origin validation identical to `/ws` (non-browser clients
  send no Origin and still need the token). Binds 127.0.0.1 only
  (existing). The token never appears in URLs, logs, or stdout.

## FR2 — floor.listBuildings

- Params: none (`{}` or absent). Returns `{total, buildings}` with
  `{path, zoneId, band, lines, parse}` per building, sorted by
  path. Empty floor → `{total:0, buildings:[]}` (missing shown as
  missing, not an error).

## FR3 — floor.getBuilding

- Params: `{path}` (non-empty string). Returns `{path, zoneId,
  band, lines, bytes, parse, imports, unresolvedImportCount,
  dependents, recentChanges, testState, notes}`.
- `imports`: sorted resolved in-repo target paths. `dependents`:
  sorted paths importing this one. `recentChanges`: last 10
  observed-change/file-written events for the path, newest first,
  `{ts, kind, fromPath?}`.
- `testState`: latest path-scoped `test-result` event →
  `{status:"pass"|"fail", passed, failed, command?, ts}`; none →
  `{status:"unknown"}`. Never fabricated.
- `notes`: stored why-notes for the path, oldest first,
  `{note, ts, agentId?}`.
- Unknown path (no current building) → -32602 `unknown-building`
  naming the path. Ghost-only paths count as unknown (buildings
  only, per plan decision 6).

## FR4 — floor.getPlan

- Params: none. Returns `{agent, ghosts, runs}`: current worker
  status, planned/abandoned ghosts `{path, state, step?}`, and the
  per-boot run ledger as-is.

## FR5 — floor.getDbSchema

- Params: none. Returns `{tables, endpoints, schemaZoneBuilt:
  false}` aggregated from per-building connection summaries:
  `tables: [{table, usedBy:[{path, access, via}]}]`,
  `endpoints: [{path, method, route, tables:[...]}]`, sorted.
- No connections anywhere → empty arrays (honest empty, not an
  error). The `false` flag names that the T7 schema-view zone is
  still open.

## FR6 — floor.annotate

- Params: `{building, note, agent?}` (`building` per the design's
  `annotate(building, note)`; `agent` optional non-empty id).
- Unknown building → -32602 `unknown-building`. Empty or
  whitespace-only note → -32602 `empty-note`. Note over 8192 chars
  after masking → -32602 `note-too-long`.
- The stored note is secret-masked (`maskContent`) before the
  durable `annotate` event (provenance observed) is appended; the
  result `{path, ts, masked}` reports whether masking fired.
- The note appears in `floor.getBuilding` read-back, in snapshot
  `notes`, and in a patch `notes` replacement; the inspector Why
  section shows it (FR9).

## FR7 — Token bootstrap (D19)

- Each boot writes `.artifex/agent-token` (mode 0600) with the
  launch token, overwriting any previous launch (rotation).
- `.artifex/.gitignore` is ensured to ignore `agent-token`
  (appended when absent; other lines never touched).
- Launch stdout prints a copy-ready curl snippet that reads the
  token file; the literal token is never printed.
- Token-file failure warns and the floor keeps serving (the UI
  self-authenticates from injected HTML; only agent bootstrap via
  file is degraded).

## FR8 — Safety (D18)

- No file writes through the interface: the only mutation is
  annotate-to-log; unknown methods and unknown message shapes are
  explicit errors.
- Note text is secret-masked before emit and HTML-escaped at the
  render boundary (textContent-only stamping); rendered markup
  from note text must be impossible (pinned by e2e).

## FR9 — Inspector Why section

- First section in the inspector (D17 order), titled "Why",
  listing the selected building's notes (agent + time + text);
  hidden when the building has no notes.
- Notes arrive over snapshot (`notes`, always present) and patch
  (`notes` full replacement, only when changed); WIRE_VERSION
  stays 1 (additive). A notes-carrying patch refreshes the shown
  inspector without blanking the preview.
- Styling uses existing DESIGN.md tokens only; notes render as
  Read-mode text (no status color).

## FR10 — Durability

- Notes rebuild from the durable event log on reboot (same
  untrusted-input discipline as ghosts: validated events only).
- Corrupt annotate lines are skipped by the existing log loader
  (warn + continue), never fatal.

## FR11 — Comfort trial

- `scripts/agent-comfort.ts --repo <dir> --port <port>` drives
  the interface over HTTP only: listBuildings (what exists),
  getPlan (what is planned), getBuilding (what changed + test
  state), annotate + read-back, getDbSchema, plus the three
  negative probes (unknown building, empty note, secret masking).
- Prints a per-step report; exits 0 only when every step passes,
  otherwise non-zero naming the first failure.

## NFRs

- NFR1: `bun test` green, `bun run typecheck` clean, raw coverage
  ≥95 funcs/lines (existing gate), `bun run e2e` green.
- NFR2: one process, one port, zero new production dependencies.
- NFR3: no `main`-only behavior in library boots (snippet print
  is `import.meta.main`-gated); tests stay hermetic in tmp
  fixtures.
