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
