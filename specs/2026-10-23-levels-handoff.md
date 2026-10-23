# Handoff: plan the new way + rewrite the governing doc (2026-10-23)

## State on arrival

Repo `/Users/dinomeschini/Documents/artifex`, branch `feat/typed-belts`,
pushed. PR #29 open against `main` (typed belts + phrases + estate slices
+ toaster). Merge parked until after the hackathon video — Dino's call.

Gates at ship: unit 798/0, typecheck clean, E2E 65 pass / 1 gated skip
(live ARCA gate, needs homologación creds), pre-publish cred scan OK
(`bun run scripts/toaster-prepublish.ts`, 208 files, no key material).

Floor server: `bash scripts/floor.sh start 4521` (status/stop/restart
subcommands; never raw bun + manual kill). Creds live in `~/.arca-homo/`
(0600, outside repo, homologación only). Never print or commit secrets;
each live ARCA proof run mints one real homologación invoice — do not
call ARCA live casually. Proof schema `toaster-gate-1` is frozen.

## What changed (why this session exists)

Dino rejected the panel-first direction: the story belongs ON the floor,
prominent, clickable in every part, understandable at a glance. That grew
into a product model that supersedes the toaster-as-endpoint framing in
`specs/2026-10-22-toaster.md`. Conclusions (also in project memory
`artifex.md`, 2026-10-23 entry):

1. **Levels.** `story, groups, modules, files, code`. Story = maximum
   abstraction, non-technical human-readable (today: the canvas story
   district / Toaster Bay). Each level speaks ONLY its own language.
   Everything connected; story is THE surface, not a side feature.
2. **Repercussions both ways.** A change at any level shows its effect at
   every other level. Downward = intent (impact lighting, ghosts for
   parts that would need to exist). Upward = consequence (proof goes
   STALE, e.g. PROVEN -> STALE; aggregates drop; story explains why).
   Selection survives ascent/descent via a "cone": the modules/files
   serving a story stage. Motivating case (Dino): add a "vacations"
   module to an HR app, see exactly why/how/where it connects.
3. **Manifest first.** Work always starts at story level. User manifests
   a want in plain language; system proposes intention + connections +
   validation; user approves ("build it"); parts materialize and connect;
   at-a-glance delta of what happened.
4. **E2E / REAL validation is maximum priority.** The SYSTEM generates
   the edge cases — a normal person cannot enumerate them. Real app,
   browser, data; third parties via sandbox/homologación. Validation
   tries to falsify; it mints proof records. No proof = unproven/stale,
   never fact. Unproven reads as trying/ghost; lamps are glyph + word,
   never color alone; recorded replay always wears RECORDED chrome.
5. **Working copy.** At work-start, fresh copy of the latest PUBLISHED
   version, scoped to "what's really necessary at a time" (the manifest's
   dependency cone). One-way: published -> copy, never back. Never run
   tests in prod, not even self-contained ones. Copy is pinned: if prod
   publishes mid-work, the copy goes visibly stale, never silently
   changes. Ship = work becomes the new published version.

Parked alt idea (memory only, do not build): same visual/proof model
applied to red/blue team cybersec.

## The task for this session

Two deliverables, in order:

1. **Iterate a plan for the new way.** Turn the 5 conclusions into a
   buildable plan in the diary style of this repo (agreed / built /
   validated sections). Cover at minimum:
   - Altitude model: level indicator, how the user ascends/descends, how
     selection/cone is represented per story stage (data shapes on the
     wire, which modules/files serve a stage).
   - Repercussion engine: what events propagate down (intent/impact) and
     up (proof staleness), the STALE proof state, aggregate recompute.
   - Manifest flow: proposal shape (story ghost, module ghosts, belts
     with why/how/where, file ghosts, validation battery), approval
     gate, materialization states, delta receipt.
   - Validation battery generation: case classes (happy, empty,
     boundary, wrong person, conflict, reversal, third-party down),
     where it runs (working copy), proof records it mints
     (environment/copy version/freshness tagging), expiry.
   - Working copy mechanics: how the cone is computed, what "necessary"
     includes (data? which tables?), refresh/staleness signals.
   Open questions to resolve with Dino while planning: exact cone
   scoping; stale-proof semantics (who re-proves, when does STALE clear);
   whether "groups" is derived from existing districts/boxes or new data.

2. **Rewrite the governing doc to the new reality.** Adjust
   `specs/2026-10-22-toaster.md` rather than spawning a parallel doc:
   rewrite the direction sections (Problem Statement, Approaches,
   Recommended Approach, Success Criteria, Next Steps, Implementation
   Tasks) to the levels/manifest/validation model; PRESERVE the diary
   record as history (T1/T2/T7 results, Decision ledger, Eng Review
   Record, proof facts). Follow `specs/README.md`: flat diaries, one
   effort = one file; if the new-way plan outgrows the toaster diary,
   start `specs/2026-10-23-levels.md` and leave a superseded-pointer at
   the top of the toaster diary. Keep `TODOS.md` in sync.

Constraints that still bind: frozen `toaster-gate-1` schema (drift fails
closed), masked CUIT only in UI/logs, no production ARCA, no raw secrets,
plain-language story surface (no code/file jargon at story level),
`DESIGN.md` governs visuals (read before UI work).

## First moves

1. Read this file, `specs/README.md`, and the conclusions entry in
   project memory (`artifex.md`, 2026-10-23).
2. Skim `specs/2026-10-22-toaster.md` (1114 lines) to know what you are
   rewriting vs preserving.
3. Draft the plan with Dino interactively — this is a planning session,
   not a build session; land the rewritten doc(s) before any code.
