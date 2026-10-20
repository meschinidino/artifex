# Zero-install preview: plan

Date: 2026-10-19. Specs `docs/ideas.md` "Zero-install preview"
as a small complete slice. Nothing here changes the local-first
product: the export is generated locally, the product neither
phones home nor gains a hosted dependency.

## Objective

Let a curious viewer reach the "oh, I get it" moment before any
setup: double-click one HTML file and see a real Artifex floor —
zones, machines, belts, minimap, search, inspector structure —
frozen at export time, with every live-only capability shown as
missing rather than faked.

## Strategy choice (decided autonomously)

Candidates from the ideas item: (a) hosted demo over a sample
repo, (b) paste-URL map that builds in the browser, (c) single-file
floor export.

**Chosen: (c) single-file floor export.** The local server already
bundles `floor-ui/app.ts` at boot and serves HTML + CSS + JS +
snapshot over versioned HTTP/WS surfaces; a static export inlines
exactly those bytes plus one frozen snapshot into one HTML file,
and `app.ts` gains an offline preview mode that renders the
embedded snapshot instead of opening a WebSocket.

Justification against the two governing axes:

- **Local-first.** The export is produced by a local script over
  the existing 127.0.0.1 surfaces and is a plain file afterward:
  no account, no upload of the viewer's code anywhere, no network
  except the existing Google Fonts links (which degrade to
  fallback fonts offline). A hosted demo inverts this — the
  product's first impression would depend on someone else's
  server — and a paste-URL map must exfiltrate repo contents to
  whatever builds it. Only the export keeps the adoption ramp
  consistent with the product's trust story.
- **Maintenance cost.** The export reuses the exact renderer,
  layout, and snapshot the product ships: one pure
  `renderPreview` formatter, one offline branch in `app.ts`, one
  script. It cannot drift from the floor because it *is* the
  floor's bytes. A hosted demo is a permanent ops liability
  (uptime, abuse, sample-repo freshness, TLS, cost) for a
  local-first tool with no backend team. A paste-URL map is
  worse: it duplicates the watcher/parser/resolver pipeline in
  the browser (or behind a build proxy, which is a hosted demo
  with extra steps) and every pipeline fix must then land twice.
  The export's ongoing cost is near zero: it breaks only when
  the snapshot or template shape changes, which the pinned tests
  catch.

## Scope

In scope:

- New pure module `preview/render.ts`: `renderPreview(input) →
  string`, turning the served template + CSS + bundle + one
  snapshot + provenance meta into a single self-contained HTML
  document.
- `floor-ui/app.ts` preview mode: when the document embeds a
  snapshot, boot offline (no WebSocket), render it, disable
  dispatch with a stated reason, short-circuit file-content
  preview to an honest "not in preview" notice, and show a
  frozen banner. Client-side interactions (pan, zoom, search,
  minimap, expand/collapse, relayout, inspector structure) keep
  working.
- `scripts/export-preview.ts --repo <dir> --out <file>`: boots
  the library server (`agent: false`), captures the served
  `/app.js`, `/styles.css`, and the first WS snapshot over the
  existing public surfaces only (no server changes), renders via
  `preview/render.ts`, writes one file. Exits non-zero naming
  the first failure.
- Distribution: CI job (`.github/workflows/preview.yml`) that
  builds `artifex-preview.html` from the artifex repo itself on
  tag push and uploads it as a release asset; README gains one
  line pointing at the latest preview asset.
- Unit + e2e tests for all new behavior; coverage stays ≥95 raw
  on both axes; `bun run typecheck` covers the new files.

Out of scope:

- Hosted demo and paste-URL map (rejected above; not fallback
  layers — the export replaces them).
- Live behavior inside the preview: no WS reconnect attempts, no
  polling, no dispatch, no file contents, no ghost animation
  beyond the frozen frame. The preview is a photograph, not a
  stream.
- Embedding file contents or secrets: the snapshot carries
  structure only (paths, bands, counts, belts, frozen ghosts /
  runs / notes). Inspector content preview stays server-only.
- Committing a generated `preview.html` to the repo: generated
  artifacts go stale; the release asset is rebuilt per tag.
- Sample-repo curation beyond the artifex repo itself: the repo
  is its own best demo (145 tracked files, real belts across
  TS), and self-export dogfoods the tool.
- `WIRE_VERSION` / snapshot shape changes: the preview consumes
  the existing v1 snapshot verbatim.

## Proposed architecture

### `preview/render.ts` (pure)

`renderPreview({ template, css, appJs, snapshot, meta }) → string`,
where `template` is the bytes of `floor-ui/index.html`:

- Replace the `/styles.css` link with an inline `<style>` block
  carrying `css`, and the `/app.js` script tag with an inline
  `<script type="module">` carrying `appJs`. No other template
  edits: the preview inherits favicon, fonts links, and DOM from
  the same template the server ships, so template drift is
  impossible.
- Replace the `%ARTIFEX_TOKEN%` interpolation (the server's
  replace target) with an empty token plus a preceding inline
  JSON embed: `<script>window.__ARTIFEX_SNAPSHOT__ = {...};
  window.__ARTIFEX_PREVIEW__ = {...meta};window.__ARTIFEX_TOKEN__
  = "";</script>`. The launch token never appears in a preview.
- Escape the embedded JSON against `</script` (bytewise replace
  `<` with `\u003c` inside the JSON literal — the standard
  embed escape; JSON.parse-equivalent on read since `app.ts`
  reads the literal, not a string).
- `meta`: `{ repo, exportedAt, artifexRev, files, belts }` —
  provenance for the frozen banner. `exportedAt` is ISO UTC;
  `artifexRev` is `git rev-parse --short HEAD` of the artifex
  checkout (or `"unknown"` when unavailable, shown as such).
- Pure and deterministic for a given input except the caller-set
  `exportedAt` (the trace-export precedent: no clock reads
  inside the formatter).

### `floor-ui/app.ts` preview mode

- Detection: `typeof window.__ARTIFEX_SNAPSHOT__ !==
  "undefined"` (and empty token) selects preview boot before
  any socket code runs. No URL-param or query-string detection:
  the file must work from `file://` with no flags.
- Boot path: validate the embedded snapshot's `v ===
  WIRE_VERSION` (mismatch → full-page honest error naming both
  versions, never a half-render), apply it through the existing
  snapshot-apply path, then skip `new WebSocket` entirely. The
  connection readout shows "preview — frozen" instead of
  "connecting…"/live states.
- Frozen banner: a curb/strip notice "Preview of `<repo>` ·
  exported `<date>` · frozen — run Artifex locally for the live
  floor", stamped from `__ARTIFEX_PREVIEW__`. Existing
  DESIGN.md tokens only, Read-mode text, no new hue (amber is
  fenced to abandoned/inferred; a preview is neither).
- Dispatch: input + Send disabled with `title`/`aria-disabled`
  reason ("dispatch needs a live server"). Runs panel shows the
  frozen ledger as-is when non-empty, else the existing empty
  treatment.
- File-content preview: `open-file` has no socket to answer, so
  the inspector shows structure rows (already in the snapshot)
  plus a muted "file contents are not in previews" line where
  the content block would go. Never a spinner, never an error
  lamp — missing shown as missing.
- Everything client-side keeps working unchanged: camera,
  zoom bands, search, selection, minimap, expand/collapse,
  relayout, legend, Day (preview) toggle.

### `scripts/export-preview.ts` (public surfaces only)

`bun run scripts/export-preview.ts --repo <dir> --out <file.html>`:

1. `createFloorServer({ repo, agent: false })` on an ephemeral
   port (the `server/agent.test.ts` precedent).
2. GET `/app.js` and `/styles.css` over HTTP; open WS with
   `server/test-client.ts`, auth with the launch token, take
   the first `snapshot` message; `stop()` the server.
3. `git rev-parse --short HEAD` in the artifex checkout for
   `meta.artifexRev` (best-effort; `"unknown"` on failure).
4. `renderPreview(...)` → write `--out` (create parent dirs;
   refuse to overwrite without `--force`).
5. Print one line: path, bytes, buildings, belts, exported-at.

No new server route, no new wire message, no auth bypass: the
script is a client like `scripts/agent-comfort.ts`.

### Distribution (`preview.yml` + README line)

- `.github/workflows/preview.yml`: on tag push (`v*`), `bun
  install`, `bun run scripts/export-preview.ts --repo . --out
  dist/artifex-preview.html`, upload to the tag's release as an
  asset. Failure fails the workflow loudly (a broken preview
  blocks the release signal, same spirit as the bundle-fails-boot
  rule).
- README: one line under the intro linking the latest release's
  `artifex-preview.html` ("no install: open the preview floor").

## Steps

1. `preview/render.ts` + `preview/render.test.ts`: formatter
   with inlining, escaping, determinism, and no-token tests.
2. `app.ts` preview mode: detection, offline boot, banner,
   dispatch disable, content-missing notice, version-mismatch
   page. Red-first where the boot path currently assumes a
   socket.
3. `scripts/export-preview.ts`: orchestration over public
   surfaces; `--help`, arg validation, `--force` gate.
4. e2e: export the mini-floor fixture, open the file over
   `file://` in headless Chromium via the committed driver,
   assert the "oh, I get it" checklist (frozen banner, building
   count, a belt, search works, dispatch disabled, zero console
   errors).
5. `preview.yml` + README line; dry-run the script against the
   artifex repo itself and open the result by hand once.
6. Validation per `validation.md`; adversarial + structured
   review before landing (repo convention).

## Risks

- `file://` module scripts: inline `<script type="module">`
  runs from `file://` with no CORS issue (no imports — the
  bundle is self-contained; verify in e2e rather than assume).
- Snapshot size for big repos: the artifex self-export is ~145
  buildings (small); a 2,500-file export embeds a few MiB of
  JSON, which browsers handle, but the script prints the byte
  count so bloat is visible. No cap in v1 — a cap would need an
  honesty rule for what got cut.
- Fonts need network: the Google Fonts links stay remote, so a
  fully offline viewer gets fallback fonts. Documented in the
  banner copy review, not fixed — self-hosting fonts would fork
  the template.
- Stale snapshots misread as live: mitigated by the frozen
  banner, the "preview — frozen" readout, and disabled dispatch
  with reasons. The e2e asserts all three are visible.
- Release-asset distribution assumes GitHub releases are where
  tags go (A3). If the builder distributes elsewhere, only the
  `preview.yml` upload step changes; the artifact is identical.

## Decisions

1. **Template reuse, not a second HTML file.** `renderPreview`
   transforms the served `index.html`. A separate
   `preview.html` template would drift from the product's DOM
   within weeks; the transform keeps one template authoritative.
2. **Script uses public surfaces only.** No server edits means
   no new auth story, no new route to secure, and the export
   path is automatically covered by existing server tests. The
   cost (boot a server to export) is seconds and invisible.
3. **Self-export over a curated fixture.** The artifex repo is
   real, always fresh at tag time, and exercises belts, zones,
   and bands honestly. A hand-curated sample would need a
   curator.
4. **Structure-only snapshot, no contents.** Embedding masked
   file contents would bloat the file and widen the secret
   surface for zero "oh, I get it" gain — the moment comes from
   the map, not the text. The inspector's missing-content line
   keeps this honest.
5. **Release asset, not committed file.** Committed generated
   files rot; a per-tag asset is always the floor of that tag.
   The e2e exports a fixture instead, so tests never depend on
   release plumbing.

## Assumptions (flagged per delegation)

- A1: `floor-ui/app.ts` applies snapshots through a path that
  an offline boot can reuse without a socket (snapshot-apply is
  not entangled with WS lifecycle beyond the call site). If it
  is entangled, step 2 includes a small refactor to split
  apply-from-transport, covered by existing tests.
- A2: the `e2e/browse.ts` driver can open `file://` URLs (plain
  Chromium navigation; no server fixture needed for this
  suite).
- A3: tags (`v*`) are cut on GitHub and releases accept assets
  via the standard upload action. If distribution differs, only
  the upload step moves.
- A4: Google Fonts links may stay remote in the preview
  (graceful fallback offline). Self-hosting is explicitly out.
- A5: `window.__ARTIFEX_SNAPSHOT__` / `__ARTIFEX_PREVIEW__`
  globals follow the existing `__ARTIFEX_TOKEN__` precedent
  (window augmentation in `app.ts`).
