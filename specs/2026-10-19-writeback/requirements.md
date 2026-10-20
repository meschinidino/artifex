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
