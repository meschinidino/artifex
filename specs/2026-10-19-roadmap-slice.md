# 2026-10-19-roadmap-slice — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# T5 — Agent interface: requirements

Date: 2026-10-19. Slice spec in `specs/2026-10-19-roadmap-slice.md`
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

## plan.md

# T5 — Agent interface (v1 contract): plan

Date: 2026-10-19. Roadmap milestone "Then: product steps", first
open actionable item. The comprehension gate (design T8) is next in
file order but human-blocked (needs a non-technical viewer and a
builder-named repo); T6/T7 stay gated per D21. T5 precedes the gate
in design step order, so it is the slice.

Source: `docs/designs/artifex-ghost-factory.md` §v1 contract (line
68), D18 safety, D19 token bootstrap, T5 verify ("agent comfort
trial without screen-scraping; annotate escaping test").

## Objective

Ship the v1 agent-facing contract so an agent can read floor state
directly instead of screen-scraping: read queries
`floor.listBuildings`, `floor.getBuilding(path)`,
`floor.getPlan`, `floor.getDbSchema`, plus the one allowed v1
action, `floor.annotate(building, note)`. No file writes through
this interface in v1 (file writes stay in the agent's own tools,
observed as ground truth).

## Scope

In scope:

- `POST /agent` JSON-RPC endpoint on the existing 127.0.0.1 server
  (same port, same launch token, same Host/Origin checks).
- New pure modules `agent-interface/queries.ts` (result builders),
  `agent-interface/protocol.ts` (dispatch + auth + envelope),
  `agent-interface/auth.ts` (token file + connect snippet).
- D19 bootstrap: 0600 `.artifex/agent-token` rotated each launch,
  `.artifex/.gitignore` keeps it uncommitted, copy-ready connect
  snippet printed at launch.
- Annotate: server-side note store backed by the durable event log
  (`annotate` events already exist in `events/`), secret-masked at
  emit, Why section in the inspector (D17 order, first section,
  hidden when empty).
- `scripts/agent-comfort.ts`: scripted comfort trial over HTTP only.
- Unit + integration tests for all new behavior; e2e for Why render
  and escaping; coverage stays ≥95 raw on both axes.

Out of scope:

- T6 ask-why, T7 schema-view zone, Replay Theater (P3).
- `docs/ideas.md` "structural trace export": adjacent but un-spec'd;
  not folded. Forward-fit noted: `floor.getBuilding` returns the
  neighborhood (imports, dependents, reachability) an export would
  compact, so the export becomes a formatting layer later.
- MCP stdio/SSE transport, per-agent tokens, a second port or
  process (D14), file writes through the interface.
- Full D17 inspector retitle (Why/Changes/Structure/Health): only
  the Why section is added, first among sections; existing rows
  keep their shape.

## Decisions

1. **Transport: same server, `POST /agent`, JSON-RPC body.**
   "MCP-style" in the design means JSON-RPC method names, not the
   stdio transport. Same port/process honors D14 (one Bun process,
   150 MiB budget) and reuses the launch token plus Host/Origin
   validation instead of inventing a second auth story. Every agent
   with shell access can `curl` it, which is also what makes the
   comfort trial honest (no screen-scraping, no bespoke client).
2. **`floor.getDbSchema` honest scope: reachability now, flagged.**
   `connections/` already proves endpoint→table reachability per
   building (PR #10). The query aggregates it floor-wide and
   carries `schemaZoneBuilt: false`, naming that the T7
   schema-view zone is still open. Returning "unavailable" would
   hide real data; returning it bare would over-claim.
3. **Escape at render, mask at emit.** D18's accepted scope says
   annotate text is "escaped and secret-masked before rendering".
   Secret masking is irreversible and happens at emit
   (`maskContent`, stored masked). HTML escaping happens at the
   render boundary via textContent-only DOM stamping (the codebase
   rule for all file/agent-derived content): pre-escaping at emit
   plus textContent would double-escape (`&lt;` shown literally).
   The `events/index.ts` annotate comment is updated to state this
   boundary.
4. **Additive wire fields, WIRE_VERSION stays 1.** Snapshot gains
   `notes` (always present, possibly empty); patch gains optional
   `notes` (full replacement, present only when changed) — the
   exact ghosts pattern. Both sides ship together and pick known
   fields; no client breaks.
5. **Token never printed literally.** D19 wants a copy-ready
   snippet; D18 forbids the token in URLs or logs. The snippet
   references the token file (`TOKEN=$(cat .artifex/agent-token)`),
   which satisfies both: copy-ready, nothing secret on stdout.
6. **Annotate targets buildings only.** Ghost paths (planned, no
   file yet) are not buildings; annotating them is an explicit
   unknown-building error, never silent. Agents annotate what
   exists; ghost steps already carry their own evidence text.
7. **`testState` derives from `test-result` events; "unknown" is
   the honest v1 value.** Nothing emits `test-result` yet, so the
   query returns `{status:"unknown"}` with no fabricated pass/fail.
   The derivation is pinned by tests over fabricated events so a
   future emitter lights it up without a query change.

## Proposed architecture

### `agent-interface/queries.ts` (pure)

Result builders over a `QueryModel` the server assembles per
request from live state (buildings, resolved imports, dependents
index, event log tail, notes, ghosts, agent status, runs,
connection summaries):

- `listBuildings(model)` → `{total, buildings[]}` sorted by path.
- `getBuilding(model, path)` → full neighborhood record (imports,
  unresolvedImportCount, dependents, recentChanges last 10 newest
  first, testState, notes) or `{error:"unknown-building"}`.
- `getPlan(model)` → `{agent, ghosts, runs}`.
- `getDbSchema(model)` → `{tables[], endpoints[], schemaZoneBuilt:
  false}` aggregated from per-building connection summaries.
- `prepareNote(raw)` → trimmed non-empty note, secret-masked,
  length-checked against MAX_TEXT_CHARS, or a named error
  (`empty-note`, `note-too-long`). Pure; the server persists.

### `agent-interface/protocol.ts` (thin)

`handleAgentRequest({token, model, annotate}, authHeader,
bodyText)` → `{status, body}`. Parses the envelope, checks
`Authorization: Bearer`, dispatches the five methods, validates
params (`building`/`path` naming: `floor.getBuilding` takes
`{path}`; `floor.annotate` takes `{building, note, agent?}` per
the design's `annotate(building, note)` signature). All errors
use the JSON-RPC envelope `{v:1, id, error:{code,message}}`:
-32601 unknown method, -32602 invalid params (incl.
unknown-building, empty-note, note-too-long), -32001 bad auth.
HTTP status: 200 for envelope errors, 401 for bad auth, 400 for
non-JSON, 413 for oversize (>64 KiB, matching the WS frame cap).

### `agent-interface/auth.ts`

- `writeAgentToken(repoDir, token)`: writes `.artifex/agent-token`
  0600 (overwrites = rotation), ensures `.artifex/.gitignore`
  ignores `agent-token` (appends the line when absent, never
  clobbers other lines). Returns false (warn at call site) on any
  failure; the floor keeps serving either way.
- `connectSnippet(port)`: copy-ready curl over the token file.

### Server wiring (`server/index.ts`, thin)

- `notesByPath` store, rebuilt from durable `annotate` events on
  boot next to `rebuildGhostsFromLog`; annotate persists via the
  existing emit/append path, marks `notesDirty`, schedules a patch.
- `POST /agent` route in `fetch()` after `/ws` (Host/Origin checks
  already apply); builds the QueryModel from live maps per
  request; responds with the protocol result.
- Token file write right after token minting, before the watcher
  subscribes (warn-only failure); snippet print in `import.meta.main`
  only (library boots in tests stay quiet).
- `GET` on `/agent` → 405; unknown paths keep existing 404.

### UI (`floor-ui/`)

- `wire.ts`: `AgentNote` type, snapshot/patch `notes`, client
  state + apply fns.
- `machines.ts`: `whyNoteLines(notes)` pure formatter (agent +
  relative time + text lines); unit-tested.
- `index.html`: Why section first among inspector sections,
  hidden when empty. `app.ts`: stamp with textContent only;
  refresh the inspector when a patch carries `notes`.
- `styles.css`: Why section from existing tokens only (no new
  hues; notes are Read-mode content, not status).

### Comfort trial (`scripts/agent-comfort.ts`)

`bun run scripts/agent-comfort.ts --repo <dir> --port <port>`:
reads the token file, calls listBuildings → getPlan → getBuilding
→ annotate → getBuilding (read-back) → getDbSchema, asserts the
honesty properties (unknown path errors, masked secret, empty
note rejected), prints a report, exits non-zero naming the first
failure. Runs against the live server during validation and stays
as the repeatable trial.

## Risks

- Coverage: every new server/UI branch needs a test; pure modules
  carry the logic so the gate holds. DOM stamping in `app.ts` is
  unreachable under bun (existing pattern) and is covered by e2e.
- Concurrent boots in tests write token files into fixture repos:
  existing tests only assert no `.tmp-` files, so no conflict.
- Watcher burst coalescing (measured 2026-10-19, fixed by write
  placement): a boot-time write to excluded `.artifex/` lands in
  the same FSEvents burst as the first real changes, and a burst
  delivered as only-excluded names schedules no watcher flush —
  the real events are lost until the 60s backstop. Writing the
  token before the watcher subscribes keeps it out of every burst.
  Latent trap for future excluded-dir writes (they must also land
  before subscription or ride their own scheduled flush); the
  watcher's skip→return is pre-existing behavior, left unchanged.

## validation.md

# T5 — Agent interface: validation

Date: 2026-10-19. Every item must pass before `specs/roadmap.md`
marks T5 done. Simulated vs end-to-end is recorded per item.

## Unit (bun test, hermetic)

- V1 `agent-interface/queries.test.ts`: listBuildings ordering/
  shape; getBuilding unknown-path error, imports/dependents
  mapping, recent-changes cap (10) + newest-first order,
  testState pass/fail/unknown derivation from fabricated events,
  notes passthrough; getPlan shape; getDbSchema aggregation +
  `schemaZoneBuilt:false` + empty-honest; prepareNote
  empty/whitespace rejection, secret masking (incl. wrapped
  values), 8192-char bound after masking.
- V2 `agent-interface/protocol.test.ts`: envelope echo of `id`
  (incl. missing id → null); missing/malformed/forged auth →
  -32001 + 401; non-JSON → 400; oversize → 413; unknown method →
  -32601; bad params per method → -32602 (incl. annotate
  error mapping from prepareNote, getBuilding unknown-building);
  happy paths return the model result verbatim.
- V3 `agent-interface/auth.test.ts`: token file content + 0600
  mode; rotation overwrites; gitignore append-vs-preserve (absent
  file, missing line, line present, other lines kept); failure
  (blocked dir) returns false; snippet contains no token and names
  the file + methods.
- V4 `floor-ui/wire.test.ts` (+ existing): snapshot/patch notes
  apply (full replacement, absent-when-unchanged), client state
  carries notes.
- V5 `floor-ui/machines.test.ts`: `whyNoteLines` strings (agent
  + time + text, missing agent), empty → empty.
- V6 existing suites stay green unmodified except `wire.test.ts`
  snapshot fixture (additive `notes` field).

## Integration (bun test, real server over tmp fixtures)

- V7 `server/agent.test.ts`: boot → token file 0600 with the
  launch token; gitignore line; `POST /agent` listBuildings over
  real HTTP; getBuilding neighborhood matches the fixture (import
  → dependent pair); annotate round-trip incl. masked secret,
  unknown-building/empty-note/too-long errors; notes in snapshot
  + patch after annotate; notes survive `stop()` + reboot;
  getPlan reflects a dispatched ghost (stub spawnFn) or honest
  idle; getDbSchema over a connections fixture (or honest empty);
  wrong-method GET → 405; bad Origin → 403.
- V8 token-file failure degrades: fixture with `.artifex` blocked
  as a file → boot warns, serves, no token file.

## Static + coverage

- V9 `bun run typecheck` clean (new files added to the
  package.json list: agent-interface ×6, scripts/agent-comfort).
- V10 `bash scripts/coverage-gate.sh` ≥95/95.

## Live trial (end-to-end, real processes)

- V11 comfort trial: boot the real server on a fixture repo,
  run `bun run scripts/agent-comfort.ts --repo <dir> --port
  <port>` → exit 0 with all steps reported; then re-run one
  negative by hand (unknown building) to see the named error.
  E2E (not simulated): real HTTP, real token file, real log.
- V12 `bun run e2e` green incl. the new Why test: annotate via
  HTTP with markup-bearing text, reload, click the machine, Why
  shows the literal text and creates no elements (escaping);
  empty-notes machine shows no Why section. E2E (headless
  Chromium via the committed driver).

## Closure

- V13 `specs/roadmap.md` T5 checkbox flips only after V1–V12
  pass; no commit/push (uncommitted until asked).
