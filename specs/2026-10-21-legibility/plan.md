# Floor legibility plan (Factorio bar)

Date: 2026-10-21. Approved direction from the nds-capital session:
the floor must read at a glance — typed belts, role-readable
machines, purpose subtitles. This plan is repo-independent: every
pass must work across the repo panel below, never tuned to one
codebase or language. Single-repo tuning fails a pass.

## Goal

Make the floor legible at a glance on any repo: a viewer can tell
what's going on — what flows where, which machines matter, what
each part does — without clicking.

## Repo panel (validation runs on all of these)

- artifex itself (TypeScript, ~200 files)
- nds-capital (Python, 122 files)
- mini-floor fixture (e2e, deterministic)
- one compiled-language repo when available (the vacations Go
  mirror was /tmp-ephemeral; name a durable one before Pass 1)

## Success Criteria

- On each panel repo, a viewer can name the 3 most important files
  and the heaviest dependency without clicking anything.
- Every belt's kind is distinguishable on canvas; near-zoom belts
  name what they carry, correctly, in every panel language.
- Machines for entry points, hubs, leaves, tests, and docs are
  visually distinct families on every panel repo.
- No new hues, no layout-instability regressions, gates stay green
  (unit/typecheck/coverage/e2e).

## Approach

All three passes are client-side render work over data the client
already holds (`BeltEdge.kind` + masked `via[]` per belt, in/out
counts per building, `get-summary` for subtitles). No parser or
protocol changes expected. Rules must be language-agnostic (path
and shape patterns, never TS-only syntax); anything that can't be
derived robustly degrades to counts, never to wrong labels. Each
pass: unit + e2e + screenshot review on the panel, then stop for
builder eyes before the next.

## Steps

**Pass 0 — Close out and record (docs, no product change)**
- Legibility milestone on `specs/roadmap.md` (done with this plan).
- `TODOS.md` synced; `CHANGELOG.md` created; memory updated.
- No commits without the builder's explicit ship ask (unchanged rule).

**Pass 1 — Typed belts** (`floor-ui/belts-view.ts`, `floor-ui/app.ts` hover)
1. Verify what structured symbol data exists client-side
   (`server/usages.ts` output shape, resolver records). If usable,
   belt labels come from data; else regex over `via[]` import
   shapes, per panel language, with use-counts as the fallback.
   Wrong labels fail the pass — counts are always acceptable.
2. Kind styles: import solid / http dashed / topic dotted, graphite
   tones only (shape, not hue — DESIGN.md D4). Ghost uses
   amber-dash; verify visually the two never read the same.
3. Width ∝ throughput: bucket by `via.length` per belt (extend the
   existing `ROLLUP_BUCKETS` pattern to mid/near bands).
4. Labels: near band shows carried symbols (cap 2 + `+n`); mid band
   shows them for hub belts only (either endpoint in-degree ≥ 5);
   far band unchanged (no labels).
5. Hover/select lights both endpoint machines on canvas and names
   the carried symbols (no card-reading required).

**Pass 2 — Role machines** (machine draw path in `floor-ui/app.ts`,
role classifier in `floor-ui/machines.ts`)
1. Classifier (pure, tested, language-agnostic path rules): entry
   (no incoming), hub (in-degree ≥ 5 or top-decile per floor),
   leaf (no outgoing), test (`*.test.*`, `test_*`, `tests/`,
   `*_test.go`, etc.), doc (`.md`), data (binary/JSON/YAML/CSV).
   Priority documented; conflicts resolve entry > hub > test >
   doc > data > leaf.
2. One glyph/shape treatment per role reusing lamp/pip/corner
   language; nameplate stays Saira.
3. Size: glyph-only by default (safe). Size-by-importance blend is
   the open builder call below — it forces a one-time relayout.

**Pass 3 — Purpose subtitles** (canvas labels + summary fetch
orchestration)
1. Near band only, machines already passing the label-priority
   gate: fetch `get-summary` (file) on becoming labeled, max 12 in
   flight, existing cache; render the "What it does" value (label
   stripped) under the nameplate.
2. Absent subtitle renders nothing (never a placeholder box).
   Summaries stay in-memory per boot (persistence is a follow-up).
3. Depends on `feat/ai-summaries` being merged, or branch pass 3
   off it. Passes 1–2 branch off `main` and are independent.

## Validation Plan

- Per pass: `bun test`, `bun run typecheck`,
  `bash scripts/coverage-gate.sh` (bar 95/95), `bun run e2e`
  (extend `window.__belts` probes where canvas behavior needs
  asserting; zero-console-errors rule holds).
- Per pass: screenshot review on every panel repo before/after
  (browse drive, committed script pattern from the contrast check).
- Pass 1 highest-risk check: label-extraction accuracy sampled live
  across every panel language (wrong labels fail the pass).
- Pass 3 cost check: subtitle fetch count + wall time measured live
  per panel repo; reported, not gated.

## Risks / Open Questions

- **Single-repo tuning**: every behavior must be demonstrated on
  the full panel; a pass tuned to one repo's idioms fails review.
- **Size-by-importance forces a relayout** (layout is persisted;
  D13 says survivors never move). Default: glyph-only. Builder
  call: accept a one-time versioned relayout for the size blend, or
  keep lines-sizing?
- **Dash proximity to ghost language**: dashed http belts vs dashed
  amber ghosts — mitigated by hue separation, must pass visual
  review.
- **Label density**: thresholds (top-2 symbols, hub in-degree ≥ 5,
  12 subtitle fetches) are starting guesses to tune live per panel.
- **Non-goals**: layout algorithm changes, parser/resolver changes
  (unless symbol data is missing), persisted summaries, T6/T7
  (still comprehension-gate-frozen).
