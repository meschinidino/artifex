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

**What:** Run a design consultation to grow the D11 token seed into a full DESIGN.md (principles, component vocabulary, token paths).

**Why:** Design review Pass 5 closed at 7/10 because no DESIGN.md exists; future screens otherwise re-derive taste from the seed paragraph.

**Context:** Seed tokens and faces live in docs/designs/artifex-ghost-factory.md (design D11). Run after the ground layer renders real density so the system describes actual surfaces, not imagined ones.

**Effort:** M
**Priority:** P3
**Depends on:** Ground layer rendering a real floor (eng review Task T3)
