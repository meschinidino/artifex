/**
 * Zero-install preview formatter: the served template + CSS + JS
 * bundle + one frozen snapshot + provenance meta into a single
 * self-contained HTML document. Pure (the trace-export precedent):
 * deterministic output for a given input, no clock reads (the
 * caller supplies `meta.exportedAt`), no I/O. The transform is
 * replacement-only against the exact served bytes, so template
 * drift breaks loudly here instead of shipping a half-live page.
 */
import type { SnapshotMessage } from "../floor-ui/wire.ts";

/** Provenance for the frozen banner; every field is caller-supplied. */
export type PreviewMeta = {
  /** Floor repo label (the snapshot's `repo`, verbatim). */
  repo: string;
  /** ISO-UTC export timestamp. */
  exportedAt: string;
  /** Short artifex rev, or "unknown" when git could not say. */
  artifexRev: string;
  /** Building count (snapshot.buildings.length). */
  files: number;
  /** Belt count (snapshot.belts.length). */
  belts: number;
};

export type RenderPreviewInput = {
  /** The bytes of floor-ui/index.html, verbatim. */
  template: string;
  /** The served /styles.css, verbatim. */
  css: string;
  /** The served /app.js bundle, verbatim. */
  appJs: string;
  /** The frozen v1 snapshot, embedded verbatim. */
  snapshot: SnapshotMessage;
  /** Provenance meta, embedded verbatim. */
  meta: PreviewMeta;
};

/** The exact served anchors renderPreview replaces (pinned by tests). */
export const PREVIEW_STYLE_ANCHOR = '<link rel="stylesheet" href="/styles.css" />';
export const PREVIEW_APP_ANCHOR = '<script type="module" src="/app.js"></script>';
export const PREVIEW_TOKEN_ANCHOR = '<script>window.__ARTIFEX_TOKEN__ = "%ARTIFEX_TOKEN%";</script>';

/**
 * The standard embed escape: every `<` becomes a unicode escape, so
 * no literal script-close (or comment-open) can occur inside the
 * embed whatever paths or notes contain. JSON-native — the literal
 * still parses to the input verbatim.
 */
function escapeEmbed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Bundle/stylesheet escapes: a literal `</script` (any case) inside
 * the inlined JS, or `</style` inside the CSS, would close the
 * embed early and break the page. The backslash form parses to
 * the same value in JS and CSS string/regex/comment positions —
 * the only places the sequence can occur in a valid bundle —
 * while the HTML parser no longer sees a close tag.
 */
function escapeJsEmbed(appJs: string): string {
  return appJs.replace(/<\/(script)/gi, (_m, word: string) => `<\\/${word}`);
}

function escapeCssEmbed(css: string): string {
  return css.replace(/<\/(style)/gi, (_m, word: string) => `<\\/${word}`);
}

export function renderPreview(input: RenderPreviewInput): string {
  const { template, css, appJs, snapshot, meta } = input;
  const anchors: [string, string][] = [
    [PREVIEW_STYLE_ANCHOR, "/styles.css stylesheet link"],
    [PREVIEW_APP_ANCHOR, "/app.js module script"],
    [PREVIEW_TOKEN_ANCHOR, "%ARTIFEX_TOKEN% interpolation"],
  ];
  for (const [anchor, label] of anchors) {
    if (!template.includes(anchor)) {
      throw new Error(`preview template is missing the ${label} (template drift?)`);
    }
  }
  const embed =
    `<script>window.__ARTIFEX_SNAPSHOT__ = ${escapeEmbed(snapshot)};` +
    `\nwindow.__ARTIFEX_PREVIEW__ = ${escapeEmbed(meta)};` +
    `\nwindow.__ARTIFEX_TOKEN__ = "";</script>`;
  // Replacer functions throughout: css/js carry `$` sequences that
  // String.replace would otherwise treat as match patterns.
  return template
    .replace(PREVIEW_STYLE_ANCHOR, () => `<style>\n${escapeCssEmbed(css)}\n</style>`)
    .replace(PREVIEW_APP_ANCHOR, () => `<script type="module">\n${escapeJsEmbed(appJs)}\n</script>`)
    .replace(PREVIEW_TOKEN_ANCHOR, () => embed);
}
