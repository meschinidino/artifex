# TODOS

## Artifex

### Multi-repo federation on one floor

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

## Floor escape for the 1,000-block cap (search / zoom-to-file)

**What:** A search + zoom-to-file escape (design D12) so any machine is reachable even when its zone exceeds the 1,000-block rendering cap. Today, files past slot 1,000 in a mega-zone are invisible and unclickable.

**Why:** The design only accepts the rendering cap because this escape exists ("missing buildings acceptable in v1 only because zoom-to-file exists"). T3a shipped the cap without the escape; the 2026-10-13 review flagged the gap. Without it, the floor silently hides files — against the text-is-truth premise.

**Effort:** M
**Priority:** P1
**Depends on:** T3a floor (shipped); pairs naturally with eng Task T4

## Scale ceilings with visible refusal

**What:** An explicit file-count ceiling with a truthful refusal ("this repo has N files; Artifex v1 supports M") instead of unbounded listing; a parser watchdog (timeout -> terminate, respawn, mark unparsed); capped line-counting for giant text files.

**Why:** The 150 MiB / 60fps budgets were measured at ~1,000 files. Nothing today stops a monorepo (or `--repo ~`) from blowing memory before the first frame, and one pathological 1 MiB file can stall the serialized parse chain. Found in the 2026-10-13 pre-landing review.

**Effort:** M
**Priority:** P2
**Depends on:** T8 potato gate defines the ceiling numbers

## One membership policy for scan and watcher

**What:** Single eligibility rule for which files are buildings, applied identically by the git listing and the live watcher. Today gitignored-but-not-hard-excluded files appear via live events and vanish on rescan/restart.

**Why:** Appear/vanish flapping breaks the floor-equals-disk claim in the opposite direction. Needs a product decision first: gitignore-honoring everywhere, or hard-excludes only everywhere.

**Effort:** S after the decision
**Priority:** P2
**Depends on:** Builder decision on the policy

## Layout compaction policy

**What:** A stated policy for reclaiming append-only layout space (gap reuse after a threshold, or suggested relayout when a zone is mostly gaps), instead of monotonic drift under create/delete churn.

**Why:** Slots and zone columns are never reclaimed; heavy agent churn exiles buildings far down empty pads, persisted forever. Stability (D13) needs its compaction counterpart written down before it surprises anyone.

**Effort:** S-M
**Priority:** P2
**Depends on:** D13 stability contract (shipped in T3a)
