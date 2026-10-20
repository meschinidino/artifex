import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_VERSION, type SnapshotMessage } from "../floor-ui/wire.ts";
import { renderPreview, type PreviewMeta, type RenderPreviewInput } from "./render.ts";

/** The real served template: anchor drift must break this suite, not the export. */
const TEMPLATE = readFileSync(join(import.meta.dir, "..", "floor-ui", "index.html"), "utf8");

function snapshot(over: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    v: WIRE_VERSION,
    type: "snapshot",
    stateVersion: 1,
    repo: "demo",
    zones: [],
    buildings: [],
    belts: [],
    total: 0,
    watcher: "watching",
    ghosts: [],
    agent: { agentId: "muse", state: "idle" },
    runs: [],
    notes: [],
    removed: [],
    removedUnplotted: [],
    footAvailable: [],
    hasLessonsSection: false,
    ...over,
  };
}

function meta(over: Partial<PreviewMeta> = {}): PreviewMeta {
  return { repo: "demo", exportedAt: "2026-10-19T00:00:00.000Z", artifexRev: "abc1234", files: 0, belts: 0, ...over };
}

function input(over: Partial<RenderPreviewInput> = {}): RenderPreviewInput {
  return {
    template: TEMPLATE,
    css: ":root{--floor:#20241d}",
    appJs: "console.log(\"floor\");",
    snapshot: snapshot(),
    meta: meta(),
    ...over,
  };
}

/** The embed <script> block, from its opener through its closing tag. */
function embedBlock(output: string): string {
  const start = output.indexOf("<script>window.__ARTIFEX_SNAPSHOT__");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = output.indexOf("</script>", start);
  expect(end).toBeGreaterThan(start);
  return output.slice(start, end + "</script>".length);
}

describe("renderPreview", () => {
  test("inlines the stylesheet and bundle, preserving every other byte", () => {
    // Value: protects=the replacement-only transform (one template
    // stays authoritative); fails_when=an anchor drifts or the
    // transform touches a byte it should not
    const css = "a::after{content:\"$&$'\"}";
    const appJs = "console.log(\"$&\", `$'`);";
    const output = renderPreview(input({ css, appJs }));
    expect(output).toContain(`<style>\n${css}\n</style>`);
    expect(output).toContain(`<script type="module">\n${appJs}\n</script>`);
    // Nothing of the served shell is lost or rewritten …
    for (const kept of [
      "<!doctype html>",
      "fonts.googleapis.com",
      "Skip to floor",
      '<canvas id="floor">',
      'id="dispatchSend"',
      'id="repo-name"',
      'id="minimap"',
    ]) {
      expect(output).toContain(kept);
    }
    // … and nothing of the live wiring survives.
    expect(output).not.toContain("/styles.css");
    expect(output).not.toContain('src="/app.js"');
    expect(output).not.toContain("%ARTIFEX_TOKEN%");
    // Swapping the three inserted blocks back yields the template exactly.
    const back = output
      .replace(`<style>\n${css}\n</style>`, '<link rel="stylesheet" href="/styles.css" />')
      .replace(`<script type="module">\n${appJs}\n</script>`, '<script type="module" src="/app.js"></script>')
      .replace(embedBlock(output), '<script>window.__ARTIFEX_TOKEN__ = "%ARTIFEX_TOKEN%";</script>');
    expect(back).toBe(TEMPLATE);
  });

  test("embed block carries the snapshot, the meta, and an empty token", () => {
    // Value: protects=the preview boot contract (app.ts reads these
    // three globals); fails_when=a global is renamed, dropped, or mistyped
    const snap = snapshot({ repo: "shop", total: 3 });
    const m = meta({ repo: "shop", files: 3, belts: 1 });
    const block = embedBlock(renderPreview(input({ snapshot: snap, meta: m })));
    const snapJson = block.slice(
      "<script>window.__ARTIFEX_SNAPSHOT__ = ".length,
      block.indexOf(";\nwindow.__ARTIFEX_PREVIEW__"),
    );
    const metaJson = block.slice(
      block.indexOf(";\nwindow.__ARTIFEX_PREVIEW__ = ") + ";\nwindow.__ARTIFEX_PREVIEW__ = ".length,
      block.indexOf(';\nwindow.__ARTIFEX_TOKEN__ = "";</script>'),
    );
    expect(JSON.parse(snapJson)).toEqual(snap);
    expect(JSON.parse(metaJson)).toEqual(m);
    expect(block).toContain('window.__ARTIFEX_TOKEN__ = "";');
  });

  test("markup-bearing paths and notes cannot break out of the embed", () => {
    // Value: protects=file:// boot when paths/notes contain markup
    // (the page must still boot; V8 covers the boot itself);
    // fails_when=the escape drops (script-close smuggles out)
    const evil = "</script><script>alert(1)</script><!--";
    const snap = snapshot({
      buildings: [{
        id: "b1", path: `src/${evil}.ts`, zoneId: "src", x: 0, y: 0, band: 0,
        lines: 1, bytes: 8, mtimeMs: 0, binary: false, parse: "ok", unresolvedCount: 0,
      }],
      notes: [{ path: `src/${evil}.ts`, note: `why "quoted" <b>bold</b> & café ✓`, ts: 7, agentId: "a" }],
      ghosts: [{ path: "x", zoneId: "src", x: 0, y: 0, state: "planned", step: `<img src=x onerror=alert(1)>` }],
    });
    const output = renderPreview(input({ snapshot: snap }));
    expect(output.split("<script").length - 1).toBe(2);
    expect(output.split("</script>").length - 1).toBe(2);
    // The escape is JSON-native: the literal still parses to the input verbatim.
    const block = embedBlock(output);
    const snapJson = block.slice(
      "<script>window.__ARTIFEX_SNAPSHOT__ = ".length,
      block.indexOf(";\nwindow.__ARTIFEX_PREVIEW__"),
    );
    expect(snapJson).not.toContain("</script");
    expect(snapJson).toContain("\\u003c");
    expect(JSON.parse(snapJson)).toEqual(snap);
    // Non-ASCII rides through unescaped.
    expect(output).toContain("café ✓");
  });

  test("close tags inside the bundle and stylesheet cannot break the embeds", () => {
    // Value: protects=file:// boot when the bundle or CSS carry a
    // literal close tag (any case) in a string; fails_when=the
    // escape drops (the embed closes early and the page breaks)
    const appJs = 'const s = "</script>"; const t = "</ScRiPt>"; console.log(s, t);';
    const css = 'a::after{content:"</style>"}';
    const output = renderPreview(input({ css, appJs }));
    expect(output).toContain('<script type="module">\nconst s = "<\\/script>"; const t = "<\\/ScRiPt>"; console.log(s, t);\n</script>');
    expect(output).toContain('<style>\na::after{content:"<\\/style>"}\n</style>');
    // Only the structural tags survive: one style pair, two script pairs.
    expect(output.split("<style").length - 1).toBe(1);
    expect(output.split("</style>").length - 1).toBe(1);
    expect(output.split("<script").length - 1).toBe(2);
    expect(output.split("</script>").length - 1).toBe(2);
  });

  test("repeated renders are byte-identical and meta flows verbatim", () => {
    // Value: protects=determinism (no clock reads in the formatter)
    // and caller-owned provenance; fails_when=a timestamp or rev is
    // generated, normalized, or dropped inside the formatter
    const m = meta({ exportedAt: "not-even-a-date", artifexRev: "unknown" });
    const a = renderPreview(input({ meta: m }));
    const b = renderPreview(input({ meta: m }));
    expect(a).toBe(b);
    expect(a).toContain("not-even-a-date");
    expect(a).toContain('"artifexRev":"unknown"');
  });

  test("a template missing an anchor throws naming the anchor", () => {
    // Value: protects=fail-loud export when index.html drifts past
    // the transform (the script maps this to a render failure);
    // fails_when=a missing anchor renders a half-live page instead
    expect(() => renderPreview(input({ template: "<html></html>" }))).toThrow(/styles\.css/);
    expect(() => renderPreview(input({
      template: TEMPLATE.replace('<link rel="stylesheet" href="/styles.css" />', "<!-- no css -->"),
    }))).toThrow(/styles\.css/);
    expect(() => renderPreview(input({
      template: TEMPLATE.replace('<script type="module" src="/app.js"></script>', "<!-- no js -->"),
    }))).toThrow(/app\.js/);
    expect(() => renderPreview(input({
      template: TEMPLATE.replace("%ARTIFEX_TOKEN%", "baked-in"),
    }))).toThrow(/%ARTIFEX_TOKEN%/);
  });
});
