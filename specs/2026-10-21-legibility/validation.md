# Legibility validation log

Running record per pass. Wrong labels fail a pass; counts are
always an acceptable fallback.

## Pass 1 step 1 — symbol-data verification (2026-10-21)

Verdict: labels come from data the client already holds, plus
conservative micro-parsers over cited import text. No parser,
protocol, or wire changes.

What `BeltEdge.via[]` carries today (`server/index.ts`
`currentBelts`, BCR4):

- Import belts: one `line N: <source text>` citation per import
  line (masked, capped at 120 chars), plus an optional `uses …`
  item naming symbols the citation text does not already name:
  - Go: `uses <alias>: A, B` when uses are determined and the
    readable target declares them; `side-effect import (no
    direct uses)` / `dot import (uses are unqualified)` for
    blank/dot imports; bare citation otherwise.
  - TS/JS: `uses A, B` for multiline statements only
    (single-line statements name symbols in the citation).
  - Python: `uses …` for imported names hidden from the cited
    line (multiline from-imports).
  - JVM: `uses …` for wildcard imports only.
  - Other languages: bare citations, no uses item.
- http belts: `METHOD /path — line N: <text>` per call.
- topic belts: `<topic> via <handler> — line N: <text>` per
  produce pair.

Label-source decision (hybrid, in priority order):

1. `uses …` / `uses <prefix>: …` items → symbol list; the
   `+N more` tail folds into the `+n` count.
2. http/topic item prefixes → `METHOD path` / topic name.
3. Single-line import citations → per-language micro-parsers
   over the cited text (TS/JS import/export-from clause,
   Python import/from, JVM explicit import). Conservative
   shapes only; masked/capped text means bail out.
4. Anything else (Go package-only lines, unrecognized
   languages/shapes) → counts (`via` citation count).

Kind styling notes: `BeltEdge.kind` is currently unused by the
canvas (belts render live/struct/dimmed only). `routeBelts`
routes one path per edge with no pair dedup, so kind-specific
strokes are expressible, but `RoutedPath` carries no edge
identity — the draw path must join routes back to edges (opaque
key passthrough, same-pair different-kind edges included).
Live belts already dash-animate (`[8s, 4s]`); kind patterns must
compose with the live state and stay distinct from the ghost
amber-dash (`[5s, 4s]`, outline rects, amber hue).

## Pass 1 — typed belts (done 2026-10-21, branch `feat/typed-belts`, uncommitted)

Implementation: `belts-view.ts` (kind/width/label pure
functions + extractor), `route.ts` (opaque edge-key
passthrough), `app.ts` (kind×width stroke batching, label
pass, endpoint lighting, `__belts` probes), unit tests in
`belts-view.test.ts` + `route.test.ts`, one e2e
(kind/labels/lit).

Design deviations from the plan (for builder ratification):

- Width buckets count CITATIONS, not via length: uses-items
  inflate via unevenly per language (every attributed Go belt
  would read mid for one relationship). Edges fit to measured
  data (0–1 thin, 2 mid, 3+ wide).
- Identical stacked labels merge to `text ×n` (37-fan hubs
  read as their union); colliding labels nudge apart along
  their own belt; anchors sit on the longest in-view segment
  (bus midpoints hang off-view).
- Dimmed belts keep kind patterns (uniform language), flat width.

Label-extraction accuracy, sampled live (zero wrong labels anywhere):

- artifex (TS): 202 belts, 182 named, 20 silent. Silence is
  >15-line statements (no server uses item), capped single
  lines, and dynamic imports. All sampled names correct.
- nds-capital (Python): 73 belts, 73 named, 0 silent. Tails
  (`+n`) and uses-item merges verified correct.
- lipgloss (Go, new durable panel repo at
  `~/Documents/misc-projects/lipgloss`): 390 belts, 251
  named, 139 silent. Silence is bare package-only citations
  on files declaring no used exported symbols (verified:
  align.go, lipgloss.go, terminal.go yield zero declared
  symbols, so per-file attribution keeps the edge unnamed).
- java-belts (throwaway /tmp fixture): live http + topic
  belts, labels `GET /api/orders` and `orders`, both correct.
- No panel repo produced a `×n` counts label live (that path
  is unit-tested only).

Screenshots (throwaway, `/tmp/artifex-panel/`): hub
near/mid per panel repo, hover trace + lit endpoints,
java dashed-http + dotted-topic (distinct from solid
imports and the ghost amber-dash), before/after on main.
Console errors: none on any floor.

Gates: unit 698/0, typecheck clean, coverage 97.62/97.88
(bar 95/95), e2e 58/0.

Follow-ups (not Pass 1 failures): server uses-item window
(15 lines) and capped single-line imports stay silent;
Go package-fanout bare edges inherit server attribution
conservatism; the wide bucket fires once panel-wide
(aesthetics for builder eyes); the legend does not document
kind dashes (no http/topic belts on real panel repos).

Addendum (purpose phrases, same branch): the first two
follow-ups are fixed — TS statement window 15→64
(`server/usages.ts`) and truncated single-line cites now get
a uses item (`tsUses` in `server/index.ts`), each with a
regression test. Log in
`specs/2026-10-21-purpose-phrases/validation.md`.
