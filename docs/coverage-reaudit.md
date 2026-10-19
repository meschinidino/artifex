# Coverage re-audit: 95% value-weighted (slices 1–6 + re-audit)

Date: 2026-10-17. Auditor: same session, independent pass over every
uncovered line in `bun test --coverage` plus the files the tool cannot
see (app.ts, subprocesses, spawned CLIs, the browser).

## Verdict

**PASS at ≈96–97% value-weighted.** Three independent framings:

| Framing | Number | Basis |
|---|---|---|
| Raw bun (unit-instrumented files) | 94.32% funcs / 93.24% lines | `bun test --coverage` |
| Artifact-corrected line coverage | ≈98.6% | §2: layout artifact (+209 proven-executed lines), E2E/spawn/seam execution the tool can't see, unreachable/dead lines excluded — each exclusion evidenced below |
| Value-weighted whole-product | ≈96.7% | §3: explicit module weights × evidenced fractions, open math |

Gates (all green at audit time):

- Unit: **316 pass / 24 skip / 0 fail**, 1679 expects, 24 files (`bun test`)
- E2E: **29/29** (22 browser + 7 harness), 109 expects, ~20s (`bun run e2e`)
- Typecheck: clean (`bun run typecheck`, all test files listed)

Skips are the browser E2E under plain `bun test` (by design: gated on
`ARTIFEX_E2E=1`).

## §1 What "serious" meant here

Every test carries a `Value:` comment (protects/fails_when/why_new).
The re-audit closed gaps by testing behavior, and where a line could
not be tested honestly it is NAMED below with its reason — no filler
tests were written to move the number. Evidence this standard held:
the new tests found and fixed **four real watcher bugs** (§5) plus one
harness isolation bug, all with failing-first tests.

## §2 Corrected line math (unit-instrumented files)

Bun reports 93.24% lines over ≈4552 executable lines (320 uncovered).
Corrections, each evidenced:

**Proven executed (tool artifact, +209 to covered):**

- `floor-ui/layout.ts` 25–233 (2.79% lines vs 92.31% funcs):
  `layout.test.ts` asserts exact outputs (determinism across input
  order, slot stability, gap cursors, rename semantics ×3,
  prototype-pollution, band/zone tables) — these assertions cannot
  pass without executing the code. Bun's line counter is wrong for
  this file; the function counter (92.31%) agrees it runs.

**Executed outside the tool's view (covered, +25):**

- `server/index.ts` 1224–1244 (CLI main, 19 lines): `server/main.test.ts`
  spawns the real CLI (boot prints URL + SIGTERM exits 0; bad repo
  exits 1 on one `error:` line). Subprocesses are invisible to unit
  coverage — same class as the pre-existing spike CLI tests.
- `e2e/browse.ts` 104, 116 (`bJs`/`bJsText`): executed by every E2E
  run (29 tests); the tool only sees unit execution.
- `server/index.ts` 1021–1022 (open-file stat catch): behavior-pinned
  by "open-file on a deleted file answers not-found either race
  order". The assertion is deterministic; which of the two not-found
  branches wins the patch-vs-request race varies run to run.
- `server/index.ts` 355–356 (persist oversize warn+skip): logic pinned
  byte-exact at the `shouldPersistLayout` seam (`seams.test.ts`,
  incl. multibyte edge); the 2-line call site is trivially implied.
  An 8MB-layout integration test was judged cost > value.

**Non-code / noise (excluded from denominator, −16):**

- `events/index.ts` 23–34: type declarations + comments (module top;
  the module provably imports — every test file does).
- `e2e/browse.ts` 42–45: timeout constants (module-top attribution).

**Proven unreachable / dead (excluded, −10):**

- `floor-ui/route.ts` 247–249: chevron fallthrough. Proof: target =
  f·total with f ∈ {0.3, 0.55, 0.8} < 1, integer segment lengths,
  `<=` comparison — some segment always catches (equality catches).
  Defensive tail only; chevron behavior itself is tested.
- `server/index.ts` 473 (single-parse path): dead — both
  `buildBuilding` callers pass 2 args (`?? null`), so
  `pre === undefined` is always false. RECOMMENDATION: remove
  (filed as a finding, not silently refactored here).
- `server/index.ts` 705/708 (rename, unknown source): unreachable —
  `fromPath` ∈ watcher-known ⟹ laid out at boot; no current code
  path skews layout from watcher-known. Kept as a guard.
- `server/index.ts` 1194–1197 (port undefined after bind): Bun sets
  port on success; unreachable past a successful bind.
- `server/store.ts` 202–203/211–212: reachable only via TOCTOU races
  (dir symlinked between load and compact; validator-added bytes
  pushing a tail over budget). Defense in depth; kept.

**Justified-uncovered (kept in denominator, ≈62 lines):** races and
fault/platform-only guards — concurrent file mutation mid-read
(server 407/440/494, store 78–79/86–87), child-death guards the
content probe couldn't trigger (tree-sitter fails closed instead;
parser 54–57/90–92/95–96/110–115/123–124/129/181–183, extract
228–229), change-pipeline failure reporters with no known thrower
(server 384/644/824/932/959/1083–1086), build-boundary
(server 856: bundle failure — CI builds it, E2E loads /app.js),
watcher restart/error/overflow/no-filename paths (162/178–180/314/
333–336/347–349/357–363), git-spawn-throw (scan 41: Bun returns a
failing exit instead — the fallback itself is tested).

Corrected: (4552 − 320 + 209 + 25) / (4552 − 16 − 10) ≈ **98.6%**.

## §3 Value-weighted whole-product math

Weights = user impact × risk, set before computing. Fractions are
evidenced per module (unit + E2E + spawn + screenshot per D1=B).

| Module | Wt | Frac | Evidence |
|---|---|---|---|
| floor-ui/app.ts (the product UI) | 30 | 0.95 | §4: 61/64 units E2E-asserted or screenshot-verified; 3 named gaps (drive mode, reduced-motion wiring, setPointerCapture call) |
| server/index.ts | 22 | 0.99 | 95.14% + seam/spawn/E2E; residual race/fault-only |
| watcher/index.ts | 10 | 0.97 | live-tested incl. 4 bugfixes; residual fault/platform-only |
| extracted floor-ui ×9 | 10 | 1.00 | 100% (artifact/unreachable-corrected) |
| parser client + protocol | 4 | 0.97 | protocol 100%; failure contract pinned; residual child-death guards |
| extract.ts + parse-run.ts | 4 | 1.00 | 98.86% + full spawn contract; residual 1 defensive line (no-tree) |
| resolver/resolver.ts | 5 | 1.00 | 100.00% |
| server/store.ts | 5 | 0.99 | corruption guards tested; residual races |
| events/index.ts | 2 | 1.00 | 100% modulo non-code |
| scan/mask/paths/intent | 3 | 1.00 | ≈100% (1 defensive line: scan 41) |
| CLI main (`bun run start`) | 2 | 1.00 | spawn tests green |
| e2e harness | 2 | 0.97 | 91.86% + exercised by all 29 E2E |
| spike/* (legacy harness) | 1 | 0.50 | CLI error paths tested; happy paths not |
| **Total** | **100** | **≈96.7%** | Σ(w·f) = 96.73 |

Sensitivity (adversarial): app.ts at 0.90 → 95.2% (still ≥95; would
require 6+ more gaps — challengers must name them; §4 lists all 3).
Screenshots at half credit → below 95 — but D1=B (user decision)
sets screenshot-verified as the canvas standard, so full credit
honors the agreement. spike at 0 → 96.2%.

## §4 app.ts unit mapping (condensed)

E2E-asserted in Chromium (22 browser tests): boot/auth/snapshot,
landing, fit-all, zoom bands + step/wheel zoom, pan, expand/collapse,
search (input/Enter/Escape/blur/arrows), jumpTo, selection +
empty-click deselect, belts + isolation, inspector + preview +
dispatch guard (button + Enter), theme toggle + repaint, legend +
dismissal persistence, chrome toggles (inspector/drawer/site-plan),
worker/follow, narrow-viewport chrome + phone-Escape, relayout
repaint, live edits + inspector refresh + list re-render, empty-floor
zero state + refill, fresh-tab reconnect. Zero-console-errors after
every test.

Screenshot-verified (D1=B visual standard): all 11 draw functions
(glyphs, machines, buildings, belts, congestion, seams, slabs,
ground, bay signs, zone extras) + minimap (also pixel-fold assert).

Named gaps (3): `?drive=1` perf mode (20s tooling run — deliberately
untested); reduced-motion wiring (logic pinned in feed/camera unit
tests; browser media not drivable); `setPointerCapture` call (throws
for synthetic pointers; drag math tested with a documented stub).

## §5 Bugs found and fixed by the coverage push

1. **Dir-delete ghosts** (watcher): coalesced platforms report one
   deep file for a whole deleted tree → siblings ghosted forever.
   Fix: climb-to-highest-gone-ancestor sweep.
2. **Rename-over survivor blindness** (watcher): loser-only event
   left the survivor's new content undetected. Fix: disturbed-dir
   re-entry into the flush.
3. **Burst-delete ghosts** (watcher): 9 unlinks → 1 event → 8 ghosts.
   Fix: membership-change verify rescan (debounced, converging).
4. **Burst-create holes** (watcher): refill stalled short (mirror of
   3). Fix: same verify extended to creates.
5. **Harness cache poisoning** (e2e): `browseBin` cache shared across
   test files served the browser driver to shell tests. Fix:
   env-keyed cache + save/restore.

Each had a failing-first test; all green now.

## §6 Residual risks and follow-ups (not counted as covered)

- Dead code: server/index.ts:473 single-parse path — remove it.
  **Removed 2026-10-18** (docs/status-sync PR): `buildBuilding`
  now takes its prebuilt batch input only; both callers already
  passed it.
- Modify-drop window: content changes under extreme coalescing heal
  via the 60s backstop only (membership is exact within ms). Named
  limitation, accepted: per-save rescans cost too much.
- Drive mode (?drive=1): untested perf tooling; test it if it becomes
  load-bearing (CI perf gate).
- spike/* happy paths: legacy harness; test if revived.
- E2E stray-tab hazard (local only): daemon-wide console buffer;
  close stray tabs before local runs (CI uses a fresh daemon).

## §7 Addendum 2026-10-18: connections (#10) + ghost layer (#11)

Both features landed after this audit, so the verdict above was
re-measured the same way (`bun test --coverage`, same session,
2026-10-18). New surface: `connections/` (literal extractor +
graph, PR #10), `agents/muse-adapter.ts` + ghost wiring in
`server/index.ts` and `floor-ui/` (PR #11).

**Raw:** 94.06% funcs / **93.83% lines** (audit baseline 94.32% /
93.24%): funcs −0.26, lines **+0.59** despite ~5,500 new lines,
because the new modules came with their own suites
(`connections/*.test.ts`, `agents/muse-adapter.test.ts`,
`server/ghost.test.ts`) and the ghost e2e.

Per-file (raw lines): `connections/graph.ts` 100%, `types.ts` 100%,
`extract.ts` 95.02% (scattered defensive branches), `agents/
muse-adapter.ts` 94.26%, `server/index.ts` 94.53% (audit: 95.14%).

Named justified-uncovered in the new code (same standard as §2 —
named, not filler-tested):

- `muse-adapter.ts:217,221` — the plan-rejection drop. Unreachable
  by construction (the extraction regex cannot produce a token the
  repo-path rule rejects); kept as defense in depth.
- `muse-adapter.ts:284-289` — kill fallback when the process-group
  kill throws (process already gone).
- `muse-adapter.ts:359-361` — stream-pump failure fallback
  (`onExit` with null code).
- `server/index.ts:1958-1994` — CLI main flag parsing for
  `--agent`/`--agent-bin`; spawn-tested at `main.test.ts` level for
  boot/SIGTERM (subprocesses invisible to the tool, same class as
  the pre-existing CLI lines in §2).
- `server/index.ts` ghost catch blocks (solidify-unbound warn,
  prompt-sent reject, spawn-throw) — failure reporters with no
  honest in-test thrower; the behaviors they guard are asserted
  (unbound → observed stands, in `ghost.test.ts` restart case).
- The real `muse` spawn path is also covered for real but outside
  this tool's view: the live 2026-10-18 dispatch on a scratch repo
  (ghosts at ~12 s, bound solidifications, done ~34 s) executed
  `defaultSpawn`/`linesOf` against the actual binary; the fixture
  test now also runs a real child process through them.

Value-weighted, same framing as §3 with two rows added
(`connections/*` wt 5 @ 0.96; `agents/muse-adapter.ts` wt 4 @
0.94) and `server/index.ts` held at 0.97 (was 0.99): Σ(w·f)
≈ 104.9 over Σw = 109 → **≈96.2%**, still ≥95. Ghost UI units are
e2e-asserted through the `__floor` probe + worker-chip DOM text
(1 new browser test), and `drawGhost` is screenshot-verified
(planned dashed outline + modify-outline on a real building,
STOP state), per the D1=B standard.

## §8 Branch coverage (measured 2026-10-18, not gated)

Bun 1.3.14 cannot report branch coverage: its lcov output has
zero `BRDA` records, and the text reporter shows funcs/lines only.
Measured instead with `istanbul-lib-instrument` via a Bun
preload plugin (throwaway, outside the repo; suite green under
instrumentation). Same blind spots as §2 (subprocesses and the
browser run invisible; 1 s dump interval biases slightly down).

| Metric (Istanbul) | Result |
|---|---|
| Branches | **71.1%** (2,336 / 3,288 branch arms taken) |
| Statements | 83.5% (3,892 / 4,662) |
| Functions | 91.1% (483 / 530) |

Worst files: `connections/extract.ts` 45.9% branches (660 arms —
the untaken mass is `?.`/`??` defensive fallbacks and per-language
variant arms, 206 `if` + 120 binary-expr of 357 untaken),
`resolver/resolver.ts` 56.3%, `connections/graph.ts` 65.6%.
Best: `server/intent.ts` 98.1%, floor-ui extracted modules
90–100%.

Reading: Bun's 93.8% line number overstates decision coverage —
a line with an untaken `??` arm still counts as covered. The
committed bar (§5) stays the value-weighted line framing; branch
is recorded here as the honest weaker axis, not gated, and not
to be chased with filler tests for defensive arms. If it is ever
gated, raise it through per-language extractor fixtures (real
inputs), not branch-tourism. Not measured at all: MC/DC and path
coverage (no tooling path under Bun), mutation score (Stryker
has no Bun runner) — the last is the only axis that would test
assertion strength rather than execution.

## §9 Addendum 2026-10-18: raw indicators ≥95 (no weighting)

The raw, unweighted indicators now clear 95% on every axis, under
BOTH of Bun's reporters — whose denominators disagree, so both
are pinned:

| Reporter | Functions | Lines |
|---|---|---|
| `bun test --coverage` (text) | 97.51% | 97.87% |
| lcov (`--coverage-reporter=lcov`) | 96.01% (553/576) | 96.60% (5538/5733) |

Suite: 377 pass / 0 fail (e2e 32/32 separate). How the gap was
closed — real behavior tests and dead-code deletion, no filler:

- **A Bun 1.3.14 coverage phantom, root-caused.** An *uncalled
  exported function at end of file* zeroes the line hits from the
  first top-level `const` its body references to EOF (bisected
  with minimal repros). `floor-ui/layout.ts` read 2.79% lines for
  exactly this reason: dead `floorWidth` (zero callers) sat at
  EOF. Deleting it restored 100%/100%. Dead `promptFileDir` (same
  class) deleted from `agents/muse-adapter.ts`. Watch for this
  signature — a file's line coverage collapsing while its tests
  pass — whenever a dead export lands at EOF.
- **Parser degraded paths** (`parser/index.ts`): runner/timeout
  test seams (mirroring the agent adapter's) let stub runners
  prove crash/garbage/wrong-batch-id/hang all resolve per-file
  `unavailable`, and that `terminate()` kills an in-flight batch.
  One expectation corrected by observation: the `parse()` wrapper
  fills a terminated batch with per-file `unavailable` results,
  never holes.
- **Driver argv contract** (`e2e/browse.ts` → 100% funcs): a stub
  driver records argv NUL-separated; each typed wrapper's exact
  argv is asserted, including fill values with quotes/`$(…)`
  staying a single argv entry. (Found while building it: a fresh
  `process.env` entry is not reliably visible to `Bun.spawn`
  children here; the stub embeds its log path instead.)
- **Graph fidelity** (`connections/graph.ts`): read+write via
  derived verbs merges to one `readwrite` hit; two implementations
  of one port resolve through the controller's own import (the
  runner-up contributes nothing, and its foreign call stays
  unresolved rather than misattributed).
- **Adapter step label** (`agents/muse-adapter.ts`): `currentStep`
  pending-only fallback, including a degrading pending-first todo.

Branch coverage (§8) unchanged as the recorded-not-gated axis;
this addendum only moves the raw function/line indicators.

## §10 Addendum 2026-10-18: session viewer (run ledger)

Raw gate still green after the feature: 97.62% funcs / 98.00%
lines (text reporter; bar 95/95). Suite 396 unit pass / 0 fail
(424 run incl. skips), 33/33 E2E. New surface and its collateral:

- `server/index.ts` ledger lines (push/cap on dispatch, terminal
  states on exit/spawn-failure, answer accumulation,
  snapshot+patch carriage): 7 focused tests in
  `server/ghost.test.ts` (done, stopped, spawn error, prompt
  masking, 30-run cap, answer accumulation, answer cap).
- `agents/muse-adapter.ts` delta channel: 1 parse test
  (text vs malformed).
- `floor-ui/runs.ts` (new): pure render builders, 7 unit tests
  (escaping, empty scope, order/selection, titles, detail,
  answer section).
- Panel chrome in `floor-ui/app.ts`: 1 E2E (toggle, honest empty
  state, Escape + close dismissal). Named gap, same class as the
  §4 canvas units: run-row selection clicks and the populated
  list need a live dispatch, which CI cannot run (no agent
  binary); the render path they drive is unit-covered, and a
  populated panel is verified live on a scratch floor (see
  README "Ghost layer").
