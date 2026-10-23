# 2026-10-21-purpose-phrases — agent diary

> Collapsed 2026-10-23 from the plan/requirements/validation
> triplet (option A: agent-private scratch, one file per effort).
> Human surface is the panel + proof records, not this file.

## requirements.md

# Belt purpose phrases — requirements (2026-10-21, builder ask)

Belts read as what they MEAN (`fetches orders`, `styles
tables`), not bare symbol names. Pulls the belt half of
legibility Pass 3 forward; Pass 3 keeps machine subtitles.

- PPH1: contract belts phrase from deterministic rules —
  http maps method→verb + path noun (`GET /api/orders` →
  `fetches orders`), topic maps to `publishes <topic>`.
  Instant, free, no LLM. Unrecognized shapes bail to symbols.
- PPH2: import belts phrase from ONE batched agent call per
  floor (symbols+paths lack the semantics rules need:
  Spanish verbs, domain nouns, test-vs-src usage). Cached by
  content hash; honest states throughout.
- PPH3: render priority phrase → symbols → counts →
  nothing. Contract phrases compute client-side (always
  available); import phrases arrive over the wire.
- PPH4: test-file importers phrase as checks (`checks result
  output`), never as uses. Detection is a filename rule fed
  to the prompt.
- PPH5: phrases stay short (≤6 words) and grounded (prompt
  constrains to the belt's own context). Stale or failed
  phrases fall back to symbols — never a wrong phrase, never
  a gap the UI hides.
- PPH6: hover/selected names `phrase — symbols` (one line,
  capped); the edge card keeps everything.

## plan.md

# Belt purpose phrases — plan

## Phase 1: contract rules (pure, instant)

`phraseForContract` in `floor-ui/belts-view.ts` + unit tests:
method→verb map, path-noun extraction (skip `{params}`,
`api`/version fillers, verb-duplicate trailing segments),
topic humanization, first-phrase + `+n` tails. `beltLabelFor`
prefers the phrase for contract belts, symbols below.

## Phase 2: import batch (server)

- `buildPhrasesPrompt(belts)`: one prompt listing every import
  belt (from/to, test flags, carried symbols, cited lines) →
  JSON map `{"from\0to": "phrase"}`.
- `runAgent` extraction from `runSummary` (raw text, no
  summary formatting) + `parsePhrasesJson` (strict map,
  ≤6-word values, unknown keys dropped).
- `get-phrases` → `phrases` wire pair: `{ state, map,
  generatedAt }`; FIFO cache keyed by prompt hash (content
  change = new key = honest staleness).
- Stub seam shared with summaries for e2e.

## Phase 3: client render + trigger

- On-demand UI trigger (toolbar button with
  unasked/pending/ready/stale/error states); stale/error
  falls back to symbols, never blocks.
- Render priority phrase → symbols → counts; hover shows
  `phrase — symbols`.
- e2e over the stub: phrases render, states transition.

## Phase 4: panel validation

Phrase accuracy sampled live per language (rules + LLM),
screenshots per panel repo, full gates, validation log.

## validation.md

# Purpose phrases — validation log (2026-10-21, branch `feat/typed-belts`, uncommitted)

Option A: contract belts phrase from rules (client-side, no agent),
import belts from one cached LLM batch per belt set (`get-phrases` /
`phrases`, `server/phrases.ts`). Phrase replaces the symbol label on
canvas; hover reads `phrase — symbols`.

## Coverage (live agent batches, one click each)

| Floor | Belts | Batch | Missing | Notes |
|---|---|---|---|---|
| artifex (TS) | 207 import | 207 | 0 | full coverage after the evidence fixes below |
| nds-capital (Py) | 73 import | 73 | 0 | |
| lipgloss (Go) | 390 import | 248 | 142 | 138 bare fan-out (honest skips), 4 flakes w/ symbol fallback |
| java-belts | 2 contract | n/a | n/a | rules only: `fetches orders`, `publishes orders` |

Go accounting: same-package fan-out gives many files one shared
import line; per-file attribution claims symbols only for files
that declare them (pre-existing conservatism), so 138 edges are
bare cites the agent cannot distinguish — it skips them per the
prompt, and the belts fall back to symbols/silence. The 4 skipped
despite symbols are scattered through the batch (not tail
truncation), all in `examples/…/main.go`; their symbol labels
(`Color`, `RoundedEnumerator`, `Println`) still render.

## Accuracy (zero wrong phrases)

Spot-verified against source usage, 2 per panel repo:

- nds `credit.py → bonds.py` "gets bond analysis": source builds
  `Bond(…)` then `analyze(bond, …)`. Correct.
- nds `bank.py → base.py` "gets result tables": `Resultado` /
  `Table` are the result-table types bank.py returns. Correct.
- lipgloss `table.go → borders.go` "frames tables with borders":
  sets `lipgloss.NormalBorder()`, `Border(…)` setter, top-border
  construction. Correct.
- lipgloss `table.go → join.go` "joins content side by side":
  `JoinHorizontal(Top, cells…)` twice. Correct.
- artifex canvas: `checks belt views`, `covers zone shapes`,
  `finds buildings by name`, `gets preview details` — all match
  the importer/target relationship on sight.
- Contract rules on java-belts: `fetches orders` (GET
  /api/orders), `publishes orders` (topic orders); hover halves
  `— orders`, `— GET /api/orders`. Correct.

## Evidence fixes (found by this validation)

The first artifex batch covered 201/207; all 6 missing were long
imports with no extractable names. Two pre-existing gaps, both
fixed with regression tests:

1. `tsStatementNames` scanned 15 lines; one-name-per-line imports
   in big files run past 20 (`server/usages.ts`, window now 64;
   test: 20-name import resolves).
2. Long single-line imports truncate in the cite (120-char cap),
   losing the names `tsUses` assumed were visible
   (`server/index.ts`: truncated cites now get a uses item like
   multiline ones; test in `server/belts.test.ts`).

Both close follow-ups listed in
`specs/2026-10-21-legibility.md`. Remaining bare
hovers: 2 dynamic `await import(…)` (documented static-analysis
fallback; phrases still land from paths).

## Interaction states (e2e over `ARTIFEX_PHRASES_STUB`)

`e2e/floor.test.ts`: trigger → ready (`Phrases ✓`), a
belt-changing edit retires to stale (`Phrases ↻`, labels fall
back to symbols), re-run → ready, stub error idles (`Phrases !`).
Probed via `window.__belts.phrases`.

## Screenshots (throwaway, `/tmp/artifex-panel/`)

`artifex-phrases.png` (5/5 phrase labels near),
`artifex-phrases-hover.png` (`checks belt displays —
aggregateZones, beltContentHash +31`, endpoints lit),
`java-phrases.png` / `java-phrases-hover.png` (rule phrases +
`—` halves). Console errors: none on any floor.

## Gates

Unit 715/0 (60 skip), typecheck clean, coverage 97.62/97.82
(bar 95/95), e2e 59/0.
