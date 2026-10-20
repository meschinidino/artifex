# Zero-install preview: requirements

Date: 2026-10-19. Slice spec in `specs/2026-10-19-preview/`
(plan.md, validation.md). Ideas authority: `docs/ideas.md`
"Zero-install preview".

## FR1 — Single-file artifact

- The export is one `.html` file: template + CSS + JS bundle +
  frozen snapshot + provenance meta, all inline. It renders by
  double-click (no server, no flags, no install).
- It works from `file://`: no `fetch` of relative assets, no
  WebSocket attempt, no dependency on `location.host`. The only
  network use is the inherited remote font links, which degrade
  to fallback fonts offline.
- The file contains no launch token, no `Authorization` material,
  and no file contents (structure only, per plan decision 4).

## FR2 — renderPreview (preview/render.ts, pure)

- Input: `{ template, css, appJs, snapshot, meta }`; output: the
  complete HTML document as a string.
- `template` is the bytes of `floor-ui/index.html`, transformed
  by replacement only: the stylesheet link → inline `<style>`
  with `css`; the `/app.js` script tag → inline
  `<script type="module">` with `appJs`; the token interpolation
  → the preview embed block. All other bytes are preserved
  verbatim.
- The embed block sets `window.__ARTIFEX_SNAPSHOT__` (the v1
  snapshot verbatim), `window.__ARTIFEX_PREVIEW__` (`meta`),
  and `window.__ARTIFEX_TOKEN__ = ""`.
- Embedded JSON escapes every `<` as a unicode escape
  (backslash-u-0-0-3-c), so no literal script-close sequence
  can occur inside the embed, whatever paths or notes contain.
  The page must still boot when paths/notes contain markup,
  quotes, and non-ASCII text.
- Deterministic: same input → byte-identical output. No clock
  reads; `meta.exportedAt` is caller-supplied.
- `meta` is `{ repo, exportedAt, artifexRev, files, belts }`:
  repo label, ISO-UTC timestamp, short rev or `"unknown"`, and
  the snapshot's building/belt counts.

## FR3 — Preview boot (floor-ui/app.ts)

- Preview mode is selected solely by the presence of
  `window.__ARTIFEX_SNAPSHOT__`, evaluated before any socket
  code runs. Live boot (token, no snapshot) is byte-for-byte the
  current behavior.
- The embedded snapshot must have `v === WIRE_VERSION`. On
  mismatch the page shows a full-page message naming the
  snapshot version and the expected version, and renders
  nothing else. Never a half-render.
- On match, the snapshot applies through the existing
  snapshot-apply path and no `WebSocket` is constructed. The
  connection readout shows "preview — frozen" (exact wording
  pinned by e2e).
- The diag hooks (`__floor`, `__belts`, `__frames`) expose the
  frozen state exactly as a live first snapshot would, so
  browser probes work unchanged.

## FR4 — Frozen banner and provenance

- A visible banner names the repo label, the export date, and
  that the floor is frozen, plus the pointer "run Artifex
  locally for the live floor".
- Styling uses existing DESIGN.md tokens only; the banner is
  Read-mode text with no status color (a preview is neither
  abandoned/inferred nor an error, so neither amber nor red).
- `meta.artifexRev === "unknown"` renders as "rev unknown"
  (missing shown as missing, not blank).

## FR5 — Live-only capabilities shown as missing

- Dispatch: the prompt input and Send are disabled with an
  exposed reason ("dispatch needs a live server" via `title`
  and `aria-disabled`), not hidden and not silently dead.
- File contents: selecting a building shows the structure rows
  available in the snapshot plus a muted line where content
  would go ("file contents are not in previews"). No spinner,
  no error lamp, no retry affordance.
- Runs panel: the frozen ledger renders as-is when the snapshot
  carries runs; otherwise the existing empty treatment. No
  "running" run ever animates (frozen frame).
- Ghosts: frozen `planned`/`abandoned` outlines render as the
  live client renders them; no sweep, no transitions.

## FR6 — Client-side interactions keep working

- Pan, zoom (all three semantic bands), building search,
  selection + inspector structure, minimap, zone expand /
  collapse, relayout, legend, and the Day (preview) toggle all
  behave as on the live floor against the frozen state.
- No console errors or unhandled rejections during a scripted
  pass over FR6 (pinned by e2e).

## FR7 — Export script (scripts/export-preview.ts)

- `bun run scripts/export-preview.ts --repo <dir> --out
  <file.html>` boots `createFloorServer({ repo, agent: false })`
  on an ephemeral port, GETs `/app.js` and `/styles.css`, takes
  the first WS `snapshot` via the existing test client with the
  launch token, stops the server, renders via FR2, and writes
  the file (creating parent dirs).
- Refuses to overwrite an existing `--out` without `--force`;
  refuses a missing/non-directory `--repo` and a non-`.html`
  `--out`. Every refusal names the offending value.
- On success prints one line: path, byte count, building count,
  belt count, exported-at. Exit 0. Any failure exits non-zero
  naming the first failure (boot, fetch, snapshot, rev-parse is
  best-effort only, render, write).
- `--help` documents flags and the structure-only property.
- Uses public surfaces only: no server edits, no new route, no
  auth bypass. `meta.artifexRev` comes from `git rev-parse
  --short HEAD` in the artifex checkout, `"unknown"` on any
  failure.

## FR8 — Distribution

- `.github/workflows/preview.yml`: on tag push (`v*`), installs,
  runs the script with `--repo . --out
  dist/artifex-preview.html`, and uploads the file as an asset
  of that tag's release. A script failure fails the workflow.
- README gains one line under the intro linking the latest
  release's `artifex-preview.html` with the words "no install".
- No generated preview file is committed to the repo at any tag.

## NFRs

- NFR1: `bun test` green, `bun run typecheck` clean (new files
  added to the package.json list: `preview/render.ts`,
  `preview/render.test.ts`, `scripts/export-preview.ts`, e2e
  additions), raw coverage ≥95 funcs/lines (existing gate),
  `bun run e2e` green.
- NFR2: zero new production dependencies; no new server
  process, port, route, or wire message; `WIRE_VERSION` stays 1.
- NFR3: no `main`-only behavior in library boots; the script is
  a client and tests stay hermetic in tmp fixtures (the e2e
  exports the mini-floor fixture, never the network).
- NFR4: the artifex self-export opens and reaches first render
  with zero console errors on a cold `file://` load (manual,
  V11).
