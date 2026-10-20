# Comprehension gate (design T8, D5 + D16 control) — runbook

Status: **READY TO RUN — not yet run.** This runbook is the procedure.
The scored protocol is
[comprehension-protocol.md](comprehension-protocol.md); this file adds
nothing to its pass bar, it only tells the runner how to execute it.
Any claim that the T8 gate passed is false until a real session is
scored and recorded.

## The only two remaining inputs

1. **Builder-named repo** — one small real repo meeting the
   eligibility rules below. Named by the builder before the session.
2. **A viewer session** — one non-technical viewer, in person (or
   screen-sharing), who has seen neither this repo nor Artifex.

No agent can substitute for either input. Do not run this gate
without both.

## Repo / fixture eligibility

The builder's pick is eligible only if ALL of these hold:

- **Real, ~20 files.** A genuine program, not a synthetic fixture.
  About 20 files (roughly 12–30); big enough to have structure,
  small enough to grasp in 2 minutes.
- **At least two responsibility areas.** The program must do at
  least two distinguishable things (e.g. sends invoices AND stores
  them) so zones on the map mean something and Q1 has a real answer
  beyond "it's Java".
- **Real folder structure.** At least two folders/dirs, so the tree
  control is a fair baseline and Q3 ("where would X live?") has a
  true answer in both conditions.
- **A demonstrable recent change.** One agent run or commit, made
  before the session, that changed observable behavior or structure
  in one area — specific enough that Q2 ("what just changed?") has a
  plain-words answer (e.g. "it now retries failed sends").
- **An X candidate.** At least one natural, not-yet-present feature
  X that clearly belongs in one area per the repo's own structure
  (e.g. "a weekly sales report" → the reporting folder). X itself is
  picked by someone who is NOT the builder (see setup).
- **Boots on the floor.** The repo loads in Artifex within the
  shipped ceilings (below `MAX_FLOOR_FILES`, parses without a floor
  full of error lamps). No secrets visible unmasked.
- **Unseen by the viewer.** The viewer has not seen this repo or
  Artifex before. If they have, pick a different repo or viewer.

## Pre-session setup (fill in BEFORE the session; no edits afterwards)

Copy these blanks into the protocol's setup section:

- Repo (named by the builder): `__________`
- The "what just changed" change (one agent run or commit, made
  before the session, not described to the viewer): `__________`
- X for question 3 (picked by someone who is NOT the builder):
  `__________` (picked by: `__________`)
- Viewer (non-technical; has not seen this repo or Artifex):
  `__________`
- Date / machine / floor URL: `__________`
- Order: tree → map (fixed; tree control FIRST so the map
  condition cannot teach answers for the control).

Pre-flight checks (runner, before the viewer arrives):

1. Floor boots on the named repo; note the URL.
2. Plain file tree view ready (same repo, no file contents visible).
3. Timer ready (2 minutes per condition). Legend available on the
   map but never pointed at.
4. The "what just changed" change is in place and visible; its
   description is written down where the viewer cannot see it.
5. X is written down, picked by the non-builder, sealed until Q3.

## Ground rules (read to yourself, not to the viewer)

- No opening files in either condition.
- The builder does not explain, hint, or react — no nods, no
  corrections, no "close!".
- Legend available but never pointed at.
- Each condition is timed separately: 2 minutes for all three
  questions inside it.

## Run procedure (step by step)

1. **Welcome (2 min, untimed).** Tell the viewer: "You'll look at
   two views of a program and answer the same 3 questions on each.
   Don't open any files — just look and tell me what you think.
   There are no wrong answers; we're testing the views, not you."
   Do not name the repo, its purpose, or the change.
2. **Condition A — tree control (2 min, timed).** Show ONLY the
   plain file tree. Start the timer. Ask the 3 fixed questions,
   exact wording:
   1. "What does this program do?"
   2. "What just changed?"
   3. "Where would X live?" (X from setup)
   Record verbatim answers (or close paraphrase marked as such),
   time used, and every file-opening attempt.
3. **Stop at 2:00.** Unanswered or half-answered questions stay as
   they are — record what was said in the time.
4. **Short break (1–2 min, untimed).** Hide the tree. Open the map
   floor on the same repo. Do not narrate what the map shows.
5. **Condition B — map (2 min, timed).** Show ONLY the map
   (legend visible, never pointed at). Start the timer. Ask the
   same 3 questions, same wording. Record verbatim answers, time
   used, and every file-opening attempt.
6. **Stop at 2:00.** Same rule: the record is what was said in time.
7. **Debrief (3–5 min, untimed).** Ask: "Was anything on the map
   confusing?" Record anything the viewer says the map made
   confusing. Thank the viewer.
8. **Score immediately** against the checklist below, while the
   session is fresh. Score each question per condition as
   correct / wrong.
9. **Record** using the blank results template below (potato-report
   format), then propagate the gate record per the protocol:
   update the decision in
   [potato-2026-10-18.md](potato-2026-10-18.md), `specs/roadmap.md`
   (T8), and the T8 checkbox in
   `docs/designs/artifex-ghost-factory.md`.

## Scoring checklist (transcribed from the protocol — authoritative)

Score per question, per condition: **correct / wrong**.

- [ ] **Q1 (tree):** names the program's purpose AND at least one
  real responsibility area visible as a zone (e.g. "it sends
  invoices and stores them"), not just a technology ("it's Java").
- [ ] **Q1 (map):** same bar, from the map alone.
- [ ] **Q2 (tree):** identifies the changed area AND what the
  change does in plain words; naming the exact file(s) is not
  required.
- [ ] **Q2 (map):** same bar, from the map alone.
- [ ] **Q3 (tree):** points to the folder where X actually belongs
  per the repo's own structure.
- [ ] **Q3 (map):** points to the zone where X actually belongs per
  the repo's own structure.
- [ ] **Map time ≤ 2:00** with no files opened.
- [ ] **Map verdict: PASS = ≥2 of 3 correct in the map condition,
  within 2 minutes, no files opened.** (A file-opening attempt
  fails that condition's "map alone" claim for that question.)
- [ ] **Tree control scored and reported** with its time, whatever
  it is. The control has no pass bar; it exists so the map's
  result means something. Report both scores and both times
  either way (D16).

## Record during the session (do not skip)

- Verbatim answers (or close paraphrase marked as such).
- Time used per condition.
- Every file-opening attempt.
- Anything the viewer said the map made confusing.

## Blank results template (potato-report format)

Copy everything below the line into the new gate-report file
(suggested name: `docs/gates/comprehension-YYYY-MM-DD.md`) and fill
it from the real session.

---

# Comprehension gate (design T8, D5/D16) — run YYYY-MM-DD

Verdict: **PASS / FAIL** (map condition: __ of 3 correct in __:__).
This is one half of the T8 gate; the potato half is recorded in
[potato-2026-10-18.md](potato-2026-10-18.md) and **PASSED** on
2026-10-18.

## Criteria (from the design ledger)

- D5: a non-technical viewer answers 3 fixed questions from the map
  alone (what does it do, what just changed, where would X live);
  pass is 2 of 3 correct within 2 minutes without opening files.
  Builder named one small real repo (~20 files) before the gate.
- D16: control — same questions on a plain file tree, X picked by
  someone other than the builder; both results reported either way.

## Method

Repo (builder-named): `__________`
"What just changed" change: `__________`
X (picked by non-builder `__________`): `__________`
Viewer (non-technical, unseen repo + Artifex): `__________`
Date / machine / floor URL: `__________`
Order: tree → map (control first). Legend available, never pointed
at. No files opened in either condition (record any attempts).
2 minutes per condition, all three questions inside each.

## Results

| Question | Tree control | Map |
|---|---|---|
| Q1 what does it do | correct / wrong — "verbatim…" | correct / wrong — "verbatim…" |
| Q2 what just changed | correct / wrong — "verbatim…" | correct / wrong — "verbatim…" |
| Q3 where would X live | correct / wrong — "verbatim…" | correct / wrong — "verbatim…" |
| Time | __:__ | __:__ |
| File-open attempts | none / describe | none / describe |
| **Verdict** | n/a (control) | **PASS / FAIL** (≥2 correct ≤2 min) |

- **Map: __ of 3 correct in __:__ — PASS / FAIL.**
- **Tree control: __ of 3 correct in __:__** (no pass bar; reported
  so the map result means something).

## Caveats (recorded, not rounded away)

- Viewer background: `__________` (how non-technical? prior exposure?)
- Repo fit vs eligibility: `__________` (file count, areas, change size)
- Anything the viewer said the map made confusing: `__________`
- Deviations from this runbook: `__________` (none, or describe)

## Gate decision (D21)

Comprehension: **PASS / FAIL**. Potato: **PASS** (2026-10-18).
Per D21 the T8 gate as a whole is therefore **PASSED / NOT PASSED**.
On a fail, the descope-or-stop decision is required before T6/T7
scope grows (ask-why polish, DB zone schema view); the dispatch half
of T6 already shipped with the ghost layer (PR #11) before the gate
was scored, so the gate applies to what remains.

---

## Time estimate

About **1–1.5 hours of human time** total (potato half already done;
T8 as a whole was budgeted at human ~4h in the design doc):

| Step | Time |
|---|---|
| Repo pick + change prep + X pick (before session day ok) | 20–30 min |
| Pre-flight (boot floor, tree view, timer, seal the answers) | 10–15 min |
| Session (welcome + 2×2 min + break + debrief) | 15–20 min |
| Scoring + writing the gate report + propagating the record | 20–30 min |

The viewer is needed for ~15–20 minutes only.

## Assumptions (flagged, decide-or-accept at run time)

1. **One viewer, n=1.** The protocol scores a single session; this
   runbook assumes one viewer is enough for the gate (matching the
   potato gate's single-sample precedent). A second viewer on a
   borderline result is allowed but not required.
2. **In-person or screen-share with control of the display.**
   Assumes the runner controls what the viewer sees (no peeking at
   file contents, no self-guided clicking into files beyond recorded
   attempts). Remote-with-viewer-driving is not covered.
3. **"Non-technical" = cannot read code for structure.** Assumes the
   viewer need not be computer-illiterate, only someone who has not
   seen this repo or Artifex and would not navigate a codebase for a
   living. Record actual background in Caveats.
4. **Repo size ~20 files ≈ 12–30.** The protocol says "about 20";
   this runbook treats 12–30 as eligible and anything outside it as
   a recorded deviation, not an auto-fail.
5. **Report filename dated like the potato report**
   (`comprehension-YYYY-MM-DD.md`). Assumes the dated-report
   convention continues; rename freely if the team prefers updating
   the protocol file in place instead.
