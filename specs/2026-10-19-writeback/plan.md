# Instruction write-back: plan

Date: 2026-10-19. Roadmap intake: `docs/ideas.md` "Instruction write-back".
Status: spec only — no code, no behavior change.

## Objective

After a run ends, record concrete, reusable lessons back into the
viewed repo's agent instruction file (`AGENTS.md`): what wasted
context, what to do differently next time. The session viewer already
keeps the raw material (prompt, result, timing in `RunRecord`,
`floor-ui/wire.ts`, rendered by `floor-ui/runs.ts`); this closes the
loop so each run can make the next one cheaper — without ever letting
the machine rewrite the human's instructions on its own.

## The decision: propose-mode, never auto-append

**Propose-mode wins. Auto-append is rejected.** Reasons, in order:

1. **Text is truth (`specs/mission.md`).** A "lesson" is a judgment,
   not a measurement. Auto-appending agent- or template-generated
   judgments into an instruction file presents unproven claims as
   standing orders — exactly the guessing the mission forbids.
2. **The instruction file is a user-owned product surface.**
   `AGENTS.md` in this repo carries the design-system rule; in a
   viewed repo it carries that team's standing orders. Silent
   machine edits to it are a trust violation, and a runaway
   feedback loop (bad lesson → worse runs → worse lessons) has no
   natural brake.
3. **Secrets and noise.** Prompts and answers are masked and capped
   in the ledger for a reason. Any automatic path from run text to a
   committed root file risks laundering a near-miss secret or a
   hallucinated "lesson" into permanent instructions.
4. **Reviewability.** A draft shown for approval is a normal human
   edit with provenance (run id, timestamp, outcome cited in the
   entry). An auto-append is an unattributed mutation the user must
   go discover.

So the slice is: the floor prepares everything (facts, placement,
formatting, preview) and the human authors and approves every word
that lands in the file.

## What exists today (measured, not assumed)

- **Raw material:** `RunRecord` (`floor-ui/wire.ts`) carries `id`,
  `sessionId`, masked+capped `prompt`, `startedAt`/`endedAt`,
  `state`, masked+capped `detail` and `answer`, optional `usage`
  (run-cost slice, landed on this branch). Ledger: per-boot, oldest
  first, capped at `MAX_RUNS = 30`, in `server/index.ts`
  (`startDispatch` / `endRun` / `touchRuns`, full-array `runs`
  snapshot/patch replacement).
- **Panel:** `floor-ui/runs.ts` builds list + detail markup
  (pure, unit-tested); `floor-ui/app.ts` owns selection and
  re-renders on `runs` patches plus a while-running refresh.
- **Write discipline precedent:** `server/store.ts` shows how this
  codebase writes into an untrusted viewed repo — no writes through
  planted symlinks, bounded reads, warn-and-degrade. The append path
  follows the same discipline.
- **Wire precedent:** client→server actions are fire-and-forget
  (`dispatch`, `stop-agent`) with failures surfaced as `notice`.
  Write-back needs a per-request ack (recorded vs refused), so it
  gets a dedicated ack message rather than overloading `notice`.
- **No lesson channel exists:** nothing today extracts, drafts, or
  stores lessons anywhere. There is no LLM-summarization seam, and
  this slice deliberately does not add one (see scope).

## Scope

In scope (the smallest complete slice):

- A "Lessons" section in the run detail view for **terminal runs
  only** (`done` / `error` / `stopped`): read-only run facts (the
  raw material, already rendered above), one textarea for the
  human's lesson lines, a live preview of the exact markdown block
  to be appended, and a `Record to AGENTS.md` button.
- Human-authored lessons only: the tool never generates lesson
  text. At most one run's lessons per append request; empty
  submissions are refused client-side.
- A new wire round-trip: client `writeback` request
  (`runId` + lesson lines) → server appends to
  `<primary-repo>/AGENTS.md` → dedicated `writeback-result` ack
  (`ok` + human-readable text), surfaced in the panel.
- Server-side append module (new `server/writeback.ts`): target
  resolution (existing `AGENTS.md` at the primary repo root only),
  symlink/bounds refusal per `store.ts` discipline, fenced-section
  placement (`## Run lessons (artifex write-back)`; created at end
  of file when absent), per-entry provenance (date, short run id,
  outcome, elapsed), secret-masking of lesson text with visible
  masking, byte caps.
- Recorded-state memory per run (client-side, per-boot like the
  ledger): after a successful ack the run's Lessons section shows
  "Recorded <clock>" and disables further recording for that run.
- Unit tests for the new builders/append logic/ack path; existing
  suites stay green.

Out of scope:

- LLM-generated or template-generated lesson drafts (the likely
  follow-up; needs a summarization seam, cost/latency policy, and
  review-UX work this slice avoids).
- Auto-append in any form, including "auto-append with undo".
- Creating `AGENTS.md` when none exists (explicit notice instead);
  editing or deleting recorded entries from the floor; recording
  lessons for running runs.
- Federated floors: only the primary repo's `AGENTS.md` is a
  target; per-district targets are deferred.
- Alternative instruction filenames (`MUSE.md`, `.agents.md`,
  `CLAUDE.md`): `AGENTS.md`-only in this slice, stated in the UI.
- Cross-run aggregation ("expensive lesson patterns"); editing the
  file's non-lesson content; any commit/push of the change.
- Any wire version bump, new production dependency, or new timer.

## Proposed architecture

### 1. Client: Lessons section in the run detail

- `renderRunDetail` gains a Lessons block for terminal runs (pure
  builders in `floor-ui/runs.ts`, staying unit-testable under bun
  with no DOM):
  - a read-only facts line reusing already-rendered values
    (outcome, elapsed, tokens state) as the visible basis;
  - a `<textarea>` (3–5 rows, maxlength per NFR caps) with
    placeholder guidance ("One lesson per line: what wasted
    context, what to do differently next time.");
  - a live `<pre>` preview of the exact block to append,
    regenerated on input, showing masked text (what you see is
    what lands);
  - a `Record to AGENTS.md` button, disabled for empty input,
    running runs, and already-recorded runs.
- `floor-ui/app.ts` owns the per-run recorded map
  (`Map<runId, recordedAtMs>`, per-boot) and the textarea draft
  (kept across re-renders while the run stays selected, dropped on
  selection change — drafts are ephemeral, like the ledger).
- Styling from CSS tokens only, matching the existing detail `dl`
  and `DESIGN.md` (no new hue, no new radius, no plate nesting);
  the textarea and preview reuse existing input/pre styles.

### 2. Wire: one request, one ack

- Client→server:
  `{ v: 1, type: "writeback", runId: string, lessons: string[] }`
  (lines already trimmed client-side; empty lines dropped).
- Server→client:
  `{ v: 1, type: "writeback-result", runId: string, ok: boolean, text: string }`
  where `text` is a short human sentence ("Recorded 2 lesson(s) in
  AGENTS.md." / "AGENTS.md is a symlink; refusing to write." /
  "No AGENTS.md at the repo root.").
- No `WIRE_VERSION` bump: additive message kinds on a bundle the
  server serves itself, same as the run-cost additive field.

### 3. Server: guarded append (`server/writeback.ts`, new module)

- `resolveTarget(repo)`: `<repo>/AGENTS.md` only. Missing →
  `{ ok: false, text: "No AGENTS.md …" }`. Symlink (file or
  parent) → refuse. Non-regular file → refuse. Size over
  `MAX_INSTRUCTIONS_BYTES` (256 KiB) → refuse.
- `buildBlock(existing, entry)`: if the file lacks the fenced
  section header, append `\n## Run lessons (artifex write-back)\n`
  first (respecting trailing-newline state); then one line per
  lesson:
  `- <YYYY-MM-DD> run <shortid> (<state>, <elapsed>): <lesson>`
  Each lesson masked via `maskContent`, capped at
  `MAX_LESSON_CHARS` (280) with visible `…`, max
  `MAX_LESSONS_PER_RUN` (5) lines per request.
- `appendWriteback(repo, run, lessons)`: read (bounded, per
  `store.ts` discipline) → build → append with `O_APPEND`
  (`appendFileSync` after the same symlink re-check `store.ts`
  does, since appends follow links). Returns the ack payload.
  Never touches any other file content; never commits.
- `server/index.ts` handles the `writeback` message: looks up the
  run in the ledger (unknown id → refuse; non-terminal run →
  refuse — the server re-checks, never trusting the client), calls
  `appendWriteback` against the primary repo, and replies with
  `writeback-result` to the requesting socket only.

## Implementation steps

1. `floor-ui/wire.ts`: `writeback` client message +
   `writeback-result` server message types (comment: lessons are
   human-authored; server re-validates run state).
2. `server/writeback.ts`: target resolution, block builder,
   guarded append + tests (header creation, header reuse,
   trailing-newline handling, symlink/missing/oversize refusal,
   masking visibility, per-line caps, max-lines cap).
3. `server/index.ts`: `writeback` handler (ledger lookup,
   terminal-state check, primary-repo append, ack reply) + tests
   (unknown run, running run, success ack, refusal ack).
4. `floor-ui/runs.ts`: Lessons builders (facts line, textarea,
   preview, button states incl. recorded/disabled) + tests
   (terminal vs running runs, empty vs filled, recorded state,
   escaping of lesson text in preview).
5. `floor-ui/app.ts`: recorded-map, draft preservation across
   re-renders, preview regeneration on input, ack handling
   (recorded state + result text) + e2e/browser assertions where
   the harness allows.
6. `bun test` + `bun run typecheck`; manual check on a live floor
   (real dispatch → write lessons → verify `AGENTS.md` diff is
   exactly the previewed block, nothing else).
7. Update `docs/ideas.md` (item graduated to spec) and
   `specs/roadmap.md` only if the builder promotes it to roadmap
   work — the spec itself does not move it.

## Risks / decisions

- **The human is the summarizer.** Slice 1 asks the user to write
  the lesson. That is a feature, not a gap: it keeps every word
  honest and ships the capture/format/placement machinery that an
  LLM-draft follow-up would reuse unchanged (draft text would just
  prefill the same textarea, still requiring approval).
- **Stale preview.** The file could change between preview and
  approval (another tab, an editor). Mitigation: the preview shows
  only the block to append, and the server appends atomically at
  end-of-file — concurrent appends interleave by line, never
  corrupt. No read-modify-write of existing content exists to go
  stale, except header insertion, which is idempotent
  (header-present check at append time).
- **Untrusted viewed repo.** Same threat model as `store.ts`:
  planted symlinks, giant files. Same answers: lstat checks on
  file and parent, byte caps, refuse-with-plain-words.
- **Masking user-typed text.** `maskContent` runs on lesson lines
  so a pasted secret cannot silently land in a root file — and the
  preview shows the masked form, so WYSIWYG holds. A lesson that
  is *about* a secret pattern still records fine (placeholders are
  readable); documented in the UI placeholder, not hidden.
- **No wire bump** is safe because server and client ship as one
  bundle; additive message kinds cannot break versioned
  snapshot/patch sequencing.

## Assumptions (flagged, decided autonomously)

- A1: `AGENTS.md` at the primary repo root is the only target.
  Rationale: it is the file this repo and the idea name; a
  filename search order is speculative generality until a viewed
  repo needs it.
- A2: Per-boot client-side recorded-state is sufficient (matches
  the per-boot ledger; a restart legitimately forgets, and
  re-recording after restart is the user's visible choice).
- A3: Caps (`MAX_LESSONS_PER_RUN = 5`, `MAX_LESSON_CHARS = 280`,
  `MAX_INSTRUCTIONS_BYTES = 256 KiB`) keep entries scannable and
  the instruction file bounded; the builder can retune without
  design change.
- A4: Entry date is server-local `YYYY-MM-DD` and the short run id
  is the first 8 of the plan UUID — enough provenance to find the
  run in logs, short enough to read.
- A5: No concurrency control beyond atomic end-append: two tabs
  recording different runs interleave cleanly; the same run
  recorded from two tabs could double-append, accepted as a
  visible, user-caused, easily reverted duplicate (both entries
  carry the same run id).

## Expected result

After any terminal run, the run detail offers a Lessons section:
the human writes what the run taught, sees exactly the block that
will land, and one click appends it — cited by run, date, and
outcome — to the repo's `AGENTS.md`. Nothing is ever written
without approval, nothing is generated by the machine, and the
failure modes (no file, symlink, oversize, running run) all speak
plainly. The loop the idea wants is closed at its smallest honest
size, with LLM drafting left as clean follow-up work.
