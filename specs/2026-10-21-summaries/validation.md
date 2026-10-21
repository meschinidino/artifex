# AI summaries: validation

- Unit: prompt assembly (caps, neighbor/uses inclusion),
  cache key/cache-hit/eviction, runner (ok/timeout/nonzero),
  stub text + error modes.
- E2E: file summarize → stub text + AI label; belt summarize
  → stub text; stub error → in-UI error; regenerate after
  patch → outdated clears.
- `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` green.
- Live check (branch floor, REAL muse run): file + belt
  summaries render with label + time; latency noted.

## Results (2026-10-21, branch feat/ai-summaries)

- Unit: 674 pass / 0 fail; summarize.test.ts 11/11
  (prompt assembly, cache key/hit/eviction, pending dedup,
  runner ok/timeout/nonzero, stub modes, 3 socket round-trips).
- `bun run typecheck` green; coverage gate 97.51/97.70 (bar 95/95).
- E2E: floor 44/44 (4 summary tests: file+cache, belt,
  failure-inline, outdated→regenerate), browse+preview 12/12.
- Live REAL `muse exec` (no stub): file summary for
  server/summarize.ts in 17.8s, coherent prose, 1 paragraph +
  bullets, labeled with AI summary + timestamp.
- Follow-up (same day): effort medium via ARTIFEX_SUMMARY_EFFORT
  (default, in cache key); plain-English 3-line format; belt
  context +2 KB endpoint content. Live: belt route→layout 14.9s
  ("draws paths between machines... belts could cut through
  machines"), file 20-50s (high agent variance; medium does not
  guarantee faster than max).
- Format fix (same day): model answers a fixed-key JSON object;
  server formats the 3 labeled lines (newlines guaranteed) with
  fenced/wrapped tolerance + raw-text fallback; UI keeps breaks
  (pre-line). Live belt 23.6s, 3 lines confirmed.
- Readability (same day): client stamps one spaced block per
  labeled line with bold labels (textContent-only); prompt uses
  full path once then short file names. Live belt 32.1s obeys;
  e2e asserts the field blocks.
- Flakes fixed along the way: failure test must request an
  uncached file (shared e2e server cache); Summarize click must
  wait for the preview head.
