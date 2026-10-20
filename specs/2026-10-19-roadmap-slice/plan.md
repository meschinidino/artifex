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
