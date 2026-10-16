# Nightshift application plan

Apply `DESIGN.md` (Nightshift Assembler) and the reviewed preview to the
real floor. Renderer stays Canvas 2D; DOM owns the chrome.

## References

- Contract: `DESIGN.md`, enforced by `AGENTS.md`.
- Interactive reference: `finalized.html` in a local designs folder
  (`a folder outside this repo`
  `factory-floor-20261016/`), reviewed to outside sign-off over 16 rounds.
  The preview is the pixel/behavior authority where `DESIGN.md` is silent;
  `DESIGN.md` wins on conflict. The preview is intentionally NOT committed
  to this repo (generated 83 KB artifact); its verification record is the
  sibling `finalized.json`.
- Reusable probe patterns (belt endpoints, bystander intersections, zoom
  alignment): kept alongside the design, port to `floor-ui/` tests.

## Non-goals

- No behavior changes beyond the design (no T4 work here).
- Dispatch backend, worker presence, and inspector Why-content need the
  ghost layer; this plan ships honest stubbed surfaces for them.
- Dayshift stays an experiment (light toggle previews only).

## Sequencing

After T4. Correctness (store, escape hatch, intent binding) lands before
paint; the T4 escape hatch surface follows this spec once both exist.

## Phase 0 — Tokens and faces (mechanical)

- Rewrite `floor-ui/styles.css` variables from the `DESIGN.md` token paths;
  delete the D11 seed names (`--surface-0..3`, `--text-primary`,
  `--accent`, `--hazard`) and update `app.ts` `color()` lookups.
- Load Anton + Saira Semi Condensed (Google Fonts, verified) alongside
  Instrument + JetBrains Mono. DOM text uses the faces directly; canvas
  labels use them via `ctx.font` after `document.fonts.ready`.
- Pretext (text measuring) applies to DOM chrome only; canvas keeps its
  own measurement. Do not pull the engine into the canvas path.

## Phase 1 — DOM chrome (port the reviewed CSS)

The preview stylesheet survived review; port it onto the real ids,
keeping values, breakpoints (900/640), and aria patterns:

- 56px top shelf: wordmark, worker chip, live counts readout, Follow /
  Inspector / ? / Day buttons with toggle lamps. Worker chip shows the
  watch state until ghost sessions exist (label it as such, no fake agent).
- Inspector drawer 320px + 44px graphite handle rail with grip chevron.
- Dispatch console 72px: prompt input + square SEND. SEND with no ghost
  layer shows a visible notice ("dispatch needs an agent session"),
  never a silent no-op.
- Status curb, corner dock (minimap plate + legend plate), sticky mobile
  sheets with the one-sheet-at-a-time exclusivity rules from the preview.
- Legend content = the one-meaning rows (lamps, amber, belts, pips,
  token, editable, chevrons, Day).

## Phase 2 — Canvas machines

In `app.ts` `drawBuilding`, per band rules already in `layout.ts`
(96 pitch, bands 28/40/56/76 line up with the design):

- Square plates, 2px borders, hard offset shadow, 10px status lamps
  (lit / hollow / red; amber reserved for planned-only ghosts).
- Connection pips (max of fan-in/fan-out, cap 5), roof plates, binary
  crates restyled to the square vocabulary.
- Nameplates in Saira per the preview's band rules (far hides names
  except error/selected; near adds line counts); red ERR tags on error.

## Phase 3 — Belts (the crux)

Today's belts are straight canvas strokes with width-bucket batching.
Target: the preview's orthogonal routing, adapted to real scale:

- Per-edge port slots on machine edges; H/V jogs for short hops.
- Bottom bus band with per-edge lanes for long-haul (zone gap ≥ 2,
  plus bystander detection: any corridor hitting a third machine drops
  to the band through the clear column gaps beside source/target).
- Chevron train on the travelled/live belt; live vs structure styling;
  far band keeps the zone rollup, restyled.
- Keep the perf architecture: route on version change, never per frame;
  keep stroke batching. Measure at 1,000 edges against the 60fps /
  150 MiB budgets; if routing misses, cap routed detail and keep the
  far rollup correct (visible, documented degradation).

## Phase 4 — Minimap, legend, inspector data

- Minimap becomes the framed plate with zoom controls + collapse;
  keep the canvas-rendered map, reframe the chrome.
- Inspector sections Why / Changes / Structure / Health. Why and
  live Changes need agent data: render explicit "no agent data"
  states until the ghost layer lands (text-is-truth: missing data
  shown as missing).

## Phase 5 — Responsive + a11y pass

- 44px touch targets, visible focus everywhere, aria-pressed /
  expanded / controls wiring, Escape cascades, reduced-motion audit
  (idle at zero animation; belt dash gated), 900/640 breakpoints.

## Verification (every phase)

- `bun test` + `bun run typecheck` green.
- Detector scan on DOM chrome holds at accepted-with-reason only.
- Adapted probe scripts: belt endpoints, bystander intersections,
  zoom alignment at 50/100/150%.
- Screenshots read at 1440x900 and 375x667 before landing.

## Backend needs (out of scope, flagged)

Worker presence, dispatch delivery, inspector Why-content, and live
Changes all need the ghost layer (`specs/roadmap.md`). This plan
stubs their surfaces honestly and lands nothing that fakes them.

## Open questions (builder)

- Confirm sequencing after T4.
- Dispatch stub wording and where undeliverable prompts go.
- Whether Dayshift graduates from experiment in v1 (default no).
