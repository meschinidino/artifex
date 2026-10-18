# TODOS

## Artifex

### Multi-repo federation on one floor — DONE (2026-10-18, branch `connections-any-repo`)

**Result:** Repeatable `--repo` federates sibling repos (shared parent) as districts on one floor. Cross-repo belts only from matched contracts: HTTP calls matched to endpoints of the service the client names (Feign `name=` vs `spring.application.name`; ambiguous or unproven destinations never match) and producer↔consumer Kafka topic pairs. Verified on UM tesorería core+sender against grep counts and the independent archmap oracle (85 cross-repo links, strict subset of archmap's 90; the 5 archmap-only links are real contract drift). Remaining limits are listed in README "Known limits".

**What:** Federate several repos on one floor: each repo a district, cross-repo belts only from real contract links (API calls, shared schemas), never guessed.

**Why:** Real projects split across repos; a single-repo floor will meet that wall. Raised by the builder during eng review (D22).

**Context:** V1 is committed single-repo (see docs/designs/artifex-ghost-factory.md, Open Questions). Start after the single-repo validation gate passes: survey district packing, repo identity, and contract-link derivation on a real multi-repo project.

**Effort:** L
**Priority:** P3
**Depends on:** Single-repo validation gate passing (eng review D21)

### Replay Theater on the shared event log

**What:** Record each agent session as a scrubbable timeline (intent, files, dependencies, test results) on the shared event log, for study and debugging.

**Why:** Both outside reviewers independently wanted a replayable floor; abandoned plans already log under the ghost rules. Strongest learning and debugging layer, usable async by non-technical viewers.

**Context:** Deferred in the design (Approach C as a layer, not the first build). Start once the ghost layer emits a full session worth replaying; mostly playback UI on data v1 already keeps.

**Effort:** M
**Priority:** P3
**Depends on:** Ghost layer and event log shipping in v1

### Grow the token seed into a full DESIGN.md

**What:** Run /gstack-design-consultation to grow the D11 token seed into a full DESIGN.md (principles, component vocabulary, token paths).

**Why:** Design review Pass 5 closed at 7/10 because no DESIGN.md exists; future screens otherwise re-derive taste from the seed paragraph.

**Context:** Seed tokens and faces live in docs/designs/artifex-ghost-factory.md (design D11). Run after the ground layer renders real density so the system describes actual surfaces, not imagined ones.

**Effort:** M
**Priority:** P3
**Depends on:** Ground layer rendering a real floor (eng review Task T3)
**Status:** Done 2026-10-16 — `DESIGN.md` + `AGENTS.md` via design-consultation, preview reviewed to sign-off.

## Floor escape for the 1,000-block cap (search / zoom-to-file) — DONE (2026-10-14, T4 PR #4)

**Result:** Search/zoom-to-file shipped (`floor-ui/search.ts`,
selection exemption in `floor-ui/visible.ts`, `+N hidden` pads);
spec in `specs/2026-10-14-t4-floor-store-escape/`.

**What:** A search + zoom-to-file escape (design D12) so any machine is reachable even when its zone exceeds the 1,000-block rendering cap. Today, files past slot 1,000 in a mega-zone are invisible and unclickable.

**Why:** The design only accepts the rendering cap because this escape exists ("missing buildings acceptable in v1 only because zoom-to-file exists"). T3a shipped the cap without the escape; the 2026-10-13 review flagged the gap. Without it, the floor silently hides files — against the text-is-truth premise.

**Effort:** M
**Priority:** P1
**Depends on:** T3a floor (shipped); pairs naturally with eng Task T4

## Scale ceilings with visible refusal — DONE (2026-10-18)

**Result:** `MAX_FLOOR_FILES = 2_500` at boot, refused with both
counts named before any state is written (`server/index.ts`).
The number comes from a potato measurement on the dev Mac (real
server over generated fixtures): 500→75 MiB, 1,000→92, 2,500→135,
3,000→153, 3,500→163, 5,000→203 RSS; 2,500 keeps ~10% headroom
under the 150 MiB budget. Live growth past the ceiling after
boot stays admitted (the floor shows what appeared); the parser
watchdog (60 s), 1 MiB parse cap, and 8 MiB state/log caps were
already in place. Full numbers in `docs/gates/`.

**What:** An explicit file-count ceiling with a truthful refusal ("this repo has N files; Artifex v1 supports M") instead of unbounded listing; a parser watchdog (timeout -> terminate, respawn, mark unparsed); capped line-counting for giant text files.

**Why:** The 150 MiB / 60fps budgets were measured at ~1,000 files. Nothing today stops a monorepo (or `--repo ~`) from blowing memory before the first frame. Found in the 2026-10-13 pre-landing review.

**Effort:** M
**Priority:** P2
**Depends on:** T8 potato gate defines the ceiling numbers

## One membership policy for scan and watcher — DONE (2026-10-18)

**Decision (builder, 2026-10-18):** gitignore-honoring everywhere —
what git ignores is never a building. Non-git folders have no
ignore declaration, so only the hard excludes apply there.
Tracked files stay members even when ignore-matched (git lists
them, so the floor does too).

**Result:** The listing is now the only eligibility rule: a flush
admits a new path (create or rename target) only if the listing
admits it, and a `.gitignore` edit triggers a membership rescan
(`watcher/index.ts`). Three live watcher tests pin it (ignored
create never enters, rename onto an ignored name is a delete,
tracked-but-ignored is admitted, un-ignoring admits without a
restart).

**What:** Single eligibility rule for which files are buildings, applied identically by the git listing and the live watcher. Today gitignored-but-not-hard-excluded files appear via live events and vanish on rescan/restart.

**Why:** Appear/vanish flapping breaks the floor-equals-disk claim in the opposite direction. Needs a product decision first: gitignore-honoring everywhere, or hard-excludes only everywhere.

**Effort:** S after the decision
**Priority:** P2
**Depends on:** Builder decision on the policy

## Layout compaction policy — DONE (2026-10-18)

**Policy:** Survivors never move (D13 untouched). A slot freed
by a delete or a cross-zone rename is reused by the next
assignment in that zone (lowest free slot wins; `nextSlot`
becomes a high-water mark), so churn height is bounded by peak
live files, not total creates. Zone columns are reclaimed only
by an explicit relayout. Free slots are derived from the
buildings record per assignment — no schema change, and gaps
in layouts persisted by older versions are reclaimed too.

**What:** A stated policy for reclaiming append-only layout space (gap reuse after a threshold, or suggested relayout when a zone is mostly gaps), instead of monotonic drift under create/delete churn.

**Why:** Slots and zone columns are never reclaimed; heavy agent churn exiles buildings far down empty pads, persisted forever. Stability (D13) needs its compaction counterpart written down before it surprises anyone.

**Effort:** S-M
**Priority:** P2
**Depends on:** D13 stability contract (shipped in T3a)

## Serious coverage to 95% — DONE (2026-10-17)

**Result:** ≈96.7% value-weighted (open math in
`docs/coverage-reaudit.md`): 316 unit pass / 0 fail, 29/29 E2E,
typecheck clean. Four real watcher bugs found and fixed by the new
tests. Raw Bun indicators later raised to ≥95 on both reporters
(2026-10-18, PR #14; 377 unit pass, 32/32 E2E at that point);
branch coverage 71.1% recorded, not gated (PR #13). Residual:
named races/fault-only guards, drive-mode/reduced-motion E2E gaps.
The dead code finding (old server:473 single-parse path) was
removed 2026-10-18 in the docs/status-sync PR.

**What:** Raise value-weighted test coverage to 95% across floor-ui and server, with breadth (every changed behavior) and depth (edge cases and error paths, not happy-path-only). Every test must protect an observable behavior or invariant and name the credible regression that would make it fail; assertion-free tests, existence checks, and tests that only mirror implementation exist to be deleted, not counted.

**Why:** The Nightshift Phases 1–3 ship went out at 50% value-weighted (coverage gate overridden): the belt router is fully unit-tested but all canvas/DOM paths are screenshot-verified only. Screenshot review catches what a human looks at, once; it is not regression protection.

**Context:** Baseline diagram and gap list in the Phases 1–3 ship PR body (`## Test Coverage`). Canvas/DOM gaps need either importable seams that production callers also use, or the E2E harness below — never test-only production seams.

**Effort:** M-L
**Priority:** P1
**Depends on:** Nightshift Phases 1–3 merged; E2E harness for canvas/DOM paths

## E2E harness for the floor (urgent) — DONE (2026-10-17)

**Result:** Committed `e2e/` (browse wrapper with SIGKILL watchdog,
mini-floor fixture, 22 browser tests + 7 hermetic harness tests,
CI workflow): 29/29 green in ~20s, zero-console-errors after every
test.

**What:** A browser-driven test harness (headless Chromium via the existing `$B` driver or a committed runner) that loads the real floor over a fixture repo and asserts rendered behavior: zoom bands far/mid/near, zone expand/collapse, search zoom-to-file, belt routing presence, legend/inspector/dispatch interactions, and zero console errors.

**Why:** Fifteen of thirty traced paths in the Phases 1–3 ship are canvas/DOM code that cannot load under bun (`location is not defined` at module level). Without a browser harness these paths can never be unit-tested; today they rely on manual screenshot review per change.

**Context:** Headless QA patterns already exist in-session (`$B goto/screenshot/console`, `window.__floor` / `window.__belts` probes); the harness commits the reusable core of those probes as repeatable tests. Test plan artifact from the Phases 1–3 ship lists affected pages, interactions, edge cases, and critical paths to encode first.

**Effort:** M
**Priority:** P1
**Depends on:** Nightshift Phases 1–3 merged
