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
