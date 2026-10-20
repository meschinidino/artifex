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
