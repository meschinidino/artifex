# Estate floor (factorio) — plan

Goal: the D boxes as a Factorio floor in the existing app. Boxes are
machines, call flows are belts, thin services hang off the sides.
Click a machine to open it (tables, endpoints, files, evidence).

## Non-goals / constraints

- The per-repo floor keeps working untouched: no changes to
  `server/index.ts` behavior, no wire breaking changes (one additive
  optional field).
- Zero wrong labels: file-semantics inspector rows hide on the estate
  floor; every number is evidence-backed or absent.

## Architecture

New standalone server `server/estate.ts` (no watcher/parser/agent),
reusing wire types + `layoutFloor` + the same `index.html`/`app.js` bundle:

- `bun run server/estate.ts --estate-dir .artifex/estate --port 4531`
- Serves a static snapshot: `repo: "estate:tes-um"`, buildings, belts,
  zones. No patches (static data, deterministic layout).
- File ops (`open-file`, `get-diff`, `get-lines`, `get-summary`,
  `get-phrases`, `export-trace`) answer the matching honest error;
  `dispatch`/`stop-agent`/`writeback` answer a read-only notice;
  `relayout` resends the snapshot.
- Client detects estate mode from the `estate:` repo prefix (one
  convention, documented in `wire.ts`).

## Data

- `.artifex/estate/estate.json` (15-service connections report, frozen)
  + `.artifex/estate/estate-boxes.json` (139 boxes, frozen grouping).
- `server/estate-build.ts` (pure, tested): JSON -> buildings/belts/zones.

## Buildings

| path | what | band |
|------|------|------|
| `core/box-NN-name` | big box (≥2 tables or ≥10 eps) | by endpoints |
| `shelf/box-NN-name` | small box | by endpoints |
| `shelf/unboxed-<table>` | unboxed table (visible mistake) | 0 |
| `services/<t\|h>-<svc>` | thin-service machine | by traffic |
| `services/<t\|h>-<core\|guarani>-yard` | unboxed files of fat repos | by traffic |

- Stable ids (`box-NN`, `svc-…`, `yard-…`, `unboxed-…`); no persistence
  needed, `layoutFloor` is deterministic.
- `conn` carries the box's real endpoints/tables/calls/topics, so the
  existing inspector sections light up. `kinds` names the machine type
  (`box`, `service`, `yard`, `unboxed`).
- New additive wire field `Building.members?: string[]` (member files);
  inspector shows a Files section for it. Main server omits it.

## Belts

- Matched calls -> owner(file) -> owner(file) with `kind: "http"` and
  `METHOD /path — line N: caller (via) → target` cites (cap 5/pair).
  Owner = box, else thin service, else fat-repo yard. Self-edges skipped.
- Top-25 shared-endpoint couplings (≥8) as steel belts with
  `shared endpoint … — line N: …` cites.
- Unmatched calls stay off the floor (count logged at boot).

## Client (`floor-ui/app.ts`, `machines.ts`, `index.html`)

- `isEstateRepo`, `estateShortName`, `estateInspectorRows`,
  `memberFilesSection` (pure + tested).
- Estate inspector: box rows (Tables/Endpoints/Files/Writes/Belts),
  conn sections (free), Files section; file rows, preview, diff,
  summarize, trace hidden; dispatch/phrases guarded with a notice.

## Validation

- `bun test`, typecheck (+ new files), coverage gate 95/95,
  `bun run e2e` green (existing suite untouched).
- New: `server/estate-build.test.ts`, `server/estate.test.ts`
  (boot + WS snapshot + error paths), client unit tests.
- Boot :4531, probe screenshot to /tmp for builder eyes.
