# Brother gate (design T8, D5 + D16 control) — scored protocol

Status: **READY TO RUN — not yet run.** Nobody has scored this;
any claim that the T8 gate passed is false until the results
section at the bottom is filled from a real session.

## What it proves

A non-technical viewer can explain a small real repo from the
map alone — and the map beats (or loses to) a plain file tree on
the same questions. Both results are reported either way (D16).

## Setup (fill in BEFORE the session; no edits afterwards)

- Repo (named by the builder, ~20 files, real): `__________`
- The "what just changed" change (one agent run or commit, made
  before the session, not described to the viewer): `__________`
- X for question 3 (picked by someone who is NOT the builder):
  `__________` (picked by: `__________`)
- Viewer (non-technical; has not seen this repo or Artifex):
  `__________`
- Date / machine / floor URL: `__________`
- Order (record it; run the tree control FIRST so the map
  condition cannot teach answers for the control): tree → map.

Ground rules: legend available but never pointed at; no opening
files in either condition; the builder does not explain, hint,
or react. Each condition is timed separately. Two minutes per
condition, all three questions inside it.

## The 3 fixed questions (same wording in both conditions)

1. "What does this program do?"
2. "What just changed?"
3. "Where would X live?" (X from setup)

## Scoring (per question, per condition: correct / wrong)

- Q1 correct = names the program's purpose and at least one real
  responsibility area visible as a zone (e.g. "it sends invoices
  and stores them"), not just a technology ("it's Java").
- Q2 correct = identifies the changed area and what the change
  does in plain words; naming the exact file(s) is not required.
- Q3 correct = points to the zone (map) or folder (tree) where X
  actually belongs per the repo's own structure.
- **Pass bar (D5): 2 of 3 correct in the map condition, within
  2 minutes, no files opened.** The control has no pass bar; it
  exists so the map's result means something. Report both
  scores and both times whatever they are.

## Record during the session

- Verbatim answers (or close paraphrase marked as such).
- Time used per condition; every file-opening attempt (fails
  that condition's "map alone" claim for that question).
- Anything the viewer said the map made confusing.

## Results (fill from the real session)

| Question | Tree control | Map |
|---|---|---|
| Q1 what does it do | | |
| Q2 what just changed | | |
| Q3 where would X live | | |
| Time | | |
| **Verdict** | n/a | pass = ≥2 correct ≤2 min |

Gate record after scoring: update the decision in
[potato-2026-10-18.md](potato-2026-10-18.md), `specs/roadmap.md`
(T8), and the T8 checkbox in
`docs/designs/artifex-ghost-factory.md`. A fail triggers the
D21 descope-or-stop decision before T6/T7 scope grows.
