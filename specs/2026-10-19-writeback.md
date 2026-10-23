# 2026-10-19-writeback — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Instruction write-back: requirements

Date: 2026-10-19. Implements `docs/ideas.md` "Instruction write-back"
as a propose-mode slice: the floor prepares, the human authors and
approves, the machine never writes unasked. Design authority:
`DESIGN.md` (tokens-only styling, missing data shown as missing),
`specs/mission.md` (text is truth — no unproven state rendered,
no guessing).

## Functional requirements

### Lessons section (run detail)

- FR1: The run detail view shows a Lessons section for terminal
  runs (`done` / `error` / `stopped`) and never for running runs.
- FR2: The section contains: a read-only facts line (outcome,
  elapsed, tokens state — values already rendered in the detail,
  restated as the visible basis), one textarea for lesson lines,
  a live preview of the exact markdown block to append, and a
  `Record to AGENTS.md` button.
- FR3: The textarea accepts one lesson per line; placeholder text
  guides toward reusable lessons ("what wasted context, what to
  do differently next time") and states that secrets are masked
  and lines are capped.
- FR4: The preview regenerates on every input event and shows the
  masked, capped block exactly as it will be appended (WYSIWYG):
  fenced-section header line only when the target file lacks it
  (see FR12), then one `- <date> run <shortid> (<state>,
  <elapsed>): <lesson>` line per non-empty lesson line.
- FR5: The Record button is disabled when the textarea holds no
  non-empty line, when the run is not terminal, or when the run
  is already recorded this boot. After a successful ack the
  section shows `Recorded <clock>` and the button stays disabled
  for that run until reboot.
- FR6: No lesson text is ever generated, templated, or prefilled
  by the floor. The textarea starts empty on every run selection.

### Wire round-trip

- FR7: Client→server `writeback` request carries
  `{ runId, lessons }` with lessons trimmed and empty lines
  dropped client-side. Requests with zero lessons are never sent.
- FR8: Server→client `writeback-result` ack carries
  `{ runId, ok, text }`; `text` is a short human sentence naming
  the outcome. The ack goes to the requesting socket only.
- FR9: The panel surfaces the ack text next to the Lessons
  section on every attempt (success or refusal), replacing any
  previous attempt's text. Refusals never alter the textarea
  draft.

### Server append

- FR10: The server looks up `runId` in the live ledger. Unknown
  id → refuse (`ok: false`, "Unknown run." or equivalent).
  Non-terminal run → refuse, even if the client claims otherwise.
- FR11: Target is `<primary-repo>/AGENTS.md` only. Missing file →
  refuse with the path named ("No AGENTS.md at the repo root —
  create one to record lessons."). Nothing is ever created.
- FR12: Placement: entries go under a fenced section headed
  exactly `## Run lessons (artifex write-back)`. If the file
  lacks that header, it is appended first (after a blank line,
  respecting the file's trailing-newline state); otherwise new
  entries append at end of file. No other file content is read
  for meaning or modified in any way.
- FR13: Entry format, one line per lesson:
  `- <YYYY-MM-DD> run <shortid> (<state>, <elapsed>): <lesson>`
  where date is server-local, shortid is the first 8 of the plan
  UUID, state is the terminal state word, elapsed uses the same
  `formatElapsed` rules as the detail view.
- FR14: Lesson text is secret-masked (`maskContent`) before
  writing, and the preview shows the masked form. Masking is
  disclosed in the UI; it is never silent.
- FR15: Caps, enforced server-side (client mirrors for UX):
  at most `MAX_LESSONS_PER_RUN = 5` non-empty lines per request
  (extras refused, not silently dropped — the ack names the cap);
  each line capped at `MAX_LESSON_CHARS = 280` with visible `…`;
  target files over `MAX_INSTRUCTIONS_BYTES = 256 KiB` are
  refused without reading further.
- FR16: Untrusted-repo discipline (per `server/store.ts`): refuse
  when `<repo>/AGENTS.md` or a traversed parent is a symlink,
  when the target is not a regular file, or when the append
  fails — each with a plain-words ack, the floor otherwise
  unaffected. The symlink check is repeated immediately before
  the append (appends follow links).
- FR17: The server never commits, stages, or otherwise touches
  version control; the change is a working-tree edit the user
  reviews with their own tools.

## Non-functional requirements

- NFR1: No wire version bump (`WIRE_VERSION` stays 1): additive
  message kinds on a server-served bundle. No new production
  dependencies; Bun + strict TypeScript throughout.
- NFR2: No new always-on work: preview renders on input events
  only; the append is O(file size, bounded) per explicit click.
  Potato budgets unchanged.
- NFR3: Tokens-only styling for new UI; figures in mono; states
  never color-only; no new hue, radius, or nested plates
  (DESIGN.md). The textarea and preview reuse existing input/pre
  styles.
- NFR4: Reduced-motion and idle-render rules hold: no animation,
  no timer; the Lessons section rides existing detail renders.
- NFR5: Regression tests accompany every behavior change, with
  `Value:` comments per repo convention; the coverage gate
  (≥95 raw indicators) must not regress.
- NFR6: Accessibility: the textarea has an associated label, the
  Record button is a real button with disabled states announced,
  ack text is plain text in the detail flow (no toast-only,
  no color-only success/failure).

## Content / data requirements

- Lesson lines are user-authored prose: masked, capped, never
  interpreted as markdown beyond the single list-item line they
  become (embedded newlines impossible by construction —
  one line in, one line out).
- Recorded-state (`runId → recordedAtMs`) lives client-side in
  memory, per-boot, matching the ledger's lifetime. It is not
  persisted, not synced across tabs, not sent over the wire.
- The fenced section header is a stable contract: future slices
  (LLM drafts, entry management) reuse the same header string.

## Acceptance criteria

- AC1: On a live floor, a terminal run's detail shows the Lessons
  section (facts + empty textarea + preview + disabled Record
  button); a running run's detail shows no Lessons section.
- AC2: Typing lesson lines enables Record and updates the preview
  to the exact block that lands; embedded `<script>`/HTML in a
  lesson renders escaped in the preview and lands as literal text
  in the file.
- AC3: Clicking Record appends exactly the previewed block to the
  repo's `AGENTS.md` (byte-identical modulo the header line when
  the section is new), shows `Recorded <clock>`, and disables
  further recording for that run; a `git diff` of the file shows
  no other change.
- AC4: Refusals speak plainly and change nothing: unknown run id,
  running run, missing `AGENTS.md`, symlinked target, oversize
  file, and over-cap submissions each yield an `ok: false` ack
  with a naming sentence, visible in the panel, file untouched —
  each pinned by a test.
- AC5: A lesson containing a secret-shaped string lands masked in
  `AGENTS.md`, and the preview showed the masked form before the
  click (WYSIWYG masking).
- AC6: `bun test` and `bun run typecheck` pass; new behavior has
  regression tests (append module, wire handler, Lessons
  rendering, ack handling).

## plan.md

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

## validation.md

# Instruction write-back: validation

Date: 2026-10-19. Run after implementation; all boxes must check
before the slice lands.

## Manual validation

- MV1 (section presence): Boot the floor on a repo with an
  `AGENTS.md`, dispatch a prompt, let it finish. Confirm the
  terminal run's detail shows the Lessons section (facts line,
  empty textarea, preview, disabled Record button), and that a
  running run's detail shows no Lessons section.
- MV2 (preview honesty): Type two lesson lines, one containing
  HTML (`<b>x</b>`) and one over 280 chars. Confirm the preview
  shows both lines escaped, the long one visibly truncated with
  `…`, the header line present iff the file lacks the section,
  and Record enabled. Clear the textarea; confirm Record
  disables and the preview empties.
- MV3 (record round-trip): With a non-empty draft, click Record.
  Confirm the panel shows `Recorded <clock>`, the button
  disables, and the ack sentence names success. Open the repo's
  `AGENTS.md`: confirm the appended block is byte-identical to
  the preview and `git diff` shows no other change. Reload-free:
  select another run and back; the recorded state persists.
- MV4 (masking WYSIWYG): In a fresh terminal run, type a lesson
  containing a secret-shaped string (e.g. `sk-live-...` per the
  masker's patterns). Confirm the preview shows it masked before
  clicking, and the file lands the masked form — never the raw
  secret.
- MV5 (refusals, each file-untouched): (a) point the floor at a
  repo without `AGENTS.md` → ack names the missing path;
  (b) replace `AGENTS.md` with a symlink → ack names the refusal;
  (c) attempt Record on a running run via crafted message (or
  devtools dispatch) → server refuses; (d) submit 6 lines →
  ack names the 5-line cap, nothing written. After each, confirm
  the textarea draft is intact and the file is unchanged.
- MV6 (two-tab interleave): With two tabs open, record different
  runs' lessons near-simultaneously. Confirm both entries land
  as intact lines (order either way, no corruption, no lost
  entry).

## Technical checks

- TC1: `bun test` — full suite green (writeback module, server
  handler, runs rendering, plus untouched suites).
- TC2: `bun run typecheck` — strict `tsc --noEmit` clean.
- TC3: Coverage gate holds: raw Bun function/line indicators ≥95
  (`scripts/coverage-gate.sh` path); new code covered by its tests.
- TC4: No hardcoded hex in new UI code (`grep` new styles/DOM for
  `#[0-9a-f]` outside token definitions); no new timer,
  animation-frame, or toast-only surface in the Lessons path.
- TC5: `WIRE_VERSION` is still 1 and `git diff --stat` touches
  only the slice's files (wire + writeback module + server
  handler + runs UI + app wiring + their tests).
- TC6: Adversarial file-state probe: read-only `AGENTS.md`
  (chmod 444) → Record yields a plain-words failure ack and the
  floor keeps serving; restore perms after. `AGENTS.md` over
  256 KiB → refused without a full read (strace/log or a test
  pinning the refusal path).

## Expected unit / integration tests

- `server/writeback.test.ts` (new): header created when absent
  (with/without trailing newline); header reused when present;
  entry line format (date, shortid, state, elapsed); per-line
  280-char cap with `…`; 6-line submission refused naming the
  cap; missing file / symlink file / symlink parent /
  non-regular file / oversize file each refused with a naming
  message; secret-shaped lesson lands masked; append failure
  (unwritable) refuses cleanly; existing file content otherwise
  byte-identical.
- `server/*.test.ts` (handler seam): `writeback` for an unknown
  run id refused; for a running run refused; for a terminal run
  appends and acks `ok: true` to the requester only; server-side
  caps enforced even when the client omits them (raw message
  with 6 lines / 500-char line).
- `floor-ui/runs.test.ts`: terminal run detail includes the
  Lessons builders output, running run excludes it; preview
  builder escapes HTML, truncates long lines, drops empty lines,
  shows the header line only when flagged absent; Record button
  states (disabled-empty, disabled-recorded, enabled-filled).
- App-level (existing harness or browser test): ack `ok: true`
  flips the run to recorded with clock text; ack `ok: false`
  shows the refusal text and preserves the draft; switching
  selection drops the draft; reboot-equivalent state reset
  forgets recorded flags.

## Browser / accessibility checks

- The textarea has a visible associated label; the Record button
  is keyboard-reachable with its disabled state announced;
  success/refusal text is in the normal detail reading flow.
- Success vs refusal is never color-only (words differ:
  `Recorded …` vs the refusal sentence).
- Narrow window: textarea + preview stack or scroll within the
  detail panel without breaking the Runs panel layout; the
  inspector overlay behavior is unchanged.
- Zero console errors after Record success and after each
  refusal (repo e2e convention).

## Closure criteria

- All acceptance criteria (AC1–AC6) in `requirements.md` hold.
- `bun test` + `bun run typecheck` pass in the landing session.
- MV3's `git diff` evidence recorded (landing note or PR body):
  the exact appended block quoted, confirming preview-equality
  and no collateral change.
- MV5/MV6/TC6 refusal and interleave results recorded: which
  probes ran, what each ack said, file-untouched confirmed.
- `docs/ideas.md` updated only as the builder directs (item
  graduated or left in intake); no scope creep beyond plan.md.
- No changes outside the slice in the final diff; the working
  tree's `AGENTS.md` itself gains no write-back entries from
  testing (test repos / fixtures only — the spec's own validation
  must not pollute the instruction file it targets).
