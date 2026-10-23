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
