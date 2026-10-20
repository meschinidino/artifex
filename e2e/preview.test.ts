/**
 * Preview E2E: the exported single-file floor over file:// in headless
 * Chromium — frozen banner, frozen readout, disabled dispatch,
 * missing-content notice, client-side interactions, and the version
 * mismatch page. No server runs while the page is open (the export
 * step boots one, then stops it before any navigation).
 *
 * Gated on ARTIFEX_E2E=1 like the floor suite. A separate file from
 * floor.test.ts with its own harness: that file's beforeEach reloads
 * the live server floor, while every test here opens a file:// URL.
 * Bun runs test files serially in one process, so the driver stays
 * uncontended across the two files.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPreview } from "../scripts/export-preview.ts";
import {
  bClick,
  bCloseAllTabs,
  bClosetab,
  bConsoleClear,
  bConsoleErrors,
  bFill,
  bGoto,
  bJs,
  bJsText,
  bNewtab,
  bPress,
  bScreenshot,
  bViewport,
  waitFor,
} from "./browse.ts";

// Probe shapes mirror the window globals in floor-ui/app.ts.
type FloorProbe = {
  version: number;
  total: number;
  rendered: number;
  zones: number;
  draws: number;
  ghosts: number;
  agent: string;
  runs: number;
  cam: { x: number; y: number; scale: number };
};
type BeltsProbe = {
  band: "far" | "mid" | "near";
  belts: number;
  aggregates: number;
  drawn: number;
  isolated: boolean;
  routed: number;
};
type SearchProbe = { query: string; matches: number; shown: number; selected: string | null };

const floor = () => bJs<FloorProbe>("window.__floor");
const belts = () => bJs<BeltsProbe>("window.__belts");
const searchProbe = () => bJs<SearchProbe>("window.__search");
const text = (sel: string) => bJsText(`document.querySelector('${sel}').textContent`);
const failDir = () => {
  const dir = join(import.meta.dir, "..", ".artifex", "e2e");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const FIXTURE = join(import.meta.dir, "fixtures", "mini-floor");
// Same mtime ladder as the floor suite: src/main.ts newest, so the
// landing camera and counts match documented values.
const MTIME_ORDER = [
  "docs/notes.md",
  "package.json",
  "data.bin",
  "lib/types.ts",
  "lib/store.ts",
  "src/broken.ts",
  "src/tests/app.ts",
  "src/util.ts",
  "src/main.ts",
];

let dir = "";
let previewUrl = "";
let mismatchUrl = "";
let exportedAt = "";

/** Full reload of the frozen page + wait for the snapshot to apply. Idempotent. */
async function loadPreview(): Promise<void> {
  await bViewport("1440x900");
  await bGoto(previewUrl);
  await waitFor(
    async () => {
      try {
        return (await floor()).version;
      } catch {
        return 0; // blank tab / mid-load: keep polling
      }
    },
    (v) => v > 0,
    { timeoutMs: 30000, label: "preview floor version > 0" },
  );
  await bConsoleClear();
}

describe.skipIf(!process.env.ARTIFEX_E2E)("preview e2e", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "artifex-preview-e2e-"));
    const repo = join(dir, "repo");
    cpSync(FIXTURE, repo, { recursive: true });
    const base = Date.now() - 120_000;
    MTIME_ORDER.forEach((f, i) => {
      const t = new Date(base + i * 1000);
      utimesSync(join(repo, f), t, t);
    });
    const out = join(dir, "floor.html");
    const r = await exportPreview({ repo, out, force: false });
    exportedAt = r.exportedAt;
    previewUrl = `file://${out}`;
    // Version-mismatch twin: the embed's v rewritten to 999. The
    // splice lands inside the snapshot literal only (the marker is
    // the embed opener, and `"v":1` first occurs at the literal).
    const html = readFileSync(out, "utf8");
    const marker = "<script>window.__ARTIFEX_SNAPSHOT__ = {";
    const at = html.indexOf(marker);
    const vAt = html.indexOf('"v":1', at);
    if (at < 0 || vAt < 0) throw new Error("embed marker not found in exported preview");
    const twin = `${join(dir, "mismatch.html")}`;
    writeFileSync(twin, `${html.slice(0, vAt)}"v":999${html.slice(vAt + '"v":1'.length)}`);
    mismatchUrl = `file://${twin}`;
    await bCloseAllTabs();
    await bNewtab();
    await loadPreview();
  }, 90000);

  // Zero console errors after EVERY test (the floor suite's
  // highest-value assertion, same reasoning: catches WS/auth/bundle
  // regressions — here it also proves no socket was attempted).
  afterEach(async () => {
    let errors: string;
    try {
      errors = await bConsoleErrors();
    } catch (e) {
      throw new Error(`console read failed (daemon/tab died mid-test?): ${(e as Error).message}`);
    }
    if (!errors.includes("(no console errors)")) {
      const shot = join(failDir(), `artifex-e2e-preview-console-${Date.now()}.png`);
      try {
        await bScreenshot(shot);
      } catch {
        // best effort; the console text below is the real evidence
      }
      throw new Error(`console errors after test (screenshot: ${shot}):\n${errors}`);
    }
  });

  afterAll(async () => {
    try {
      await bClosetab();
    } catch {
      // leave the daemon as found; teardown must not fail the run
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  // Value: protects=V8 (file:// boot: frozen banner, frozen readout,
  // disabled dispatch, no-contents notice, diag parity);
  // fails_when=the preview branch, the embed, or the bundle regresses.
  test("file:// boot renders the frozen floor with its honesty chrome", async () => {
    await loadPreview();
    expect(await bJsText("location.protocol")).toBe("file:");
    const f = await floor();
    expect(f.version).toBeGreaterThan(0);
    expect(f.total).toBe(9);
    expect(f.zones).toBe(4);
    expect(f.rendered).toBe(7);
    expect(f.draws).toBeGreaterThan(0);
    expect(await text("#status-count")).toBe("7 of 9 machines");
    expect(await bJs<boolean>("document.querySelector('#search').disabled")).toBe(false);
    // Frozen banner names the repo label and the export date …
    const banner = await text("#preview-banner");
    expect(banner).toContain("Preview of repo");
    expect(banner).toContain(exportedAt);
    expect(banner).toContain("frozen");
    expect(banner).toContain("run Artifex locally for the live floor");
    // … the readout pins the frozen wording …
    expect(await text("#conn-state")).toBe("preview — frozen");
    expect(await bJs<boolean>("document.querySelector('#workerBtn').classList.contains('disconnected')")).toBe(true);
    // … and dispatch is disabled with its reason exposed, not hidden.
    for (const sel of ["#prompt", "#dispatchSend"]) {
      expect(await bJs<boolean>(`document.querySelector('${sel}').disabled`)).toBe(true);
      expect(await bJsText(`document.querySelector('${sel}').title`)).toBe("dispatch needs a live server");
      expect(await bJsText(`document.querySelector('${sel}').getAttribute('aria-disabled')`)).toBe("true");
    }
    // Selecting a building shows structure rows plus the
    // missing-content line — no spinner, no error lamp.
    await bFill("#search", "store");
    await bPress("Enter");
    await waitFor(async () => (await searchProbe()).selected, (v) => v === "lib/store.ts", {
      label: "jump selects lib/store.ts",
    });
    expect(await text("#insp-path")).toContain("lib/store.ts");
    expect(await text("#insp-lines")).not.toBe("");
    expect(await bJs<boolean>("document.querySelector('#insp-note').hidden")).toBe(false);
    expect(await text("#insp-note")).toBe("file contents are not in previews");
    expect(await bJs<boolean>("document.querySelector('#insp-content').hidden")).toBe(true);
    await bScreenshot(join(failDir(), `artifex-e2e-preview-smoke-${Date.now()}.png`));
  }, 60000);

  // Value: protects=V9 (search, zoom bands, zone toggle, site plan,
  // Day toggle behave as live; no WebSocket is ever constructed);
  // fails_when=client-side behavior entangles with the socket.
  test("frozen interactions behave as live and no socket opens", async () => {
    await loadPreview();
    // Search narrows to the known path.
    await bFill("#search", "main");
    await waitFor(async () => (await searchProbe()).matches, (n) => n >= 1, { label: "search matches main" });
    expect(await bJs<boolean>("document.querySelector('#search-results').hidden")).toBe(false);
    await bPress("Escape");
    // Zoom crosses bands (far rollup ↔ mid paths).
    await bClick("#expand-all");
    await waitFor(async () => (await floor()).rendered, (n) => n === 9, { label: "expand-all renders 9" });
    for (let i = 0; i < 14 && (await belts()).band !== "far"; i++) await bClick("#zoomOut");
    expect((await belts()).band).toBe("far");
    expect((await belts()).drawn).toBe(0);
    for (let i = 0; i < 14 && (await belts()).band === "far"; i++) await bClick("#zoomIn");
    expect((await belts()).band).not.toBe("far");
    expect((await belts()).drawn).toBeGreaterThan(0);
    // Zone toggle, site plan, Day toggle.
    await bClick("#collapse-all");
    await waitFor(async () => (await floor()).rendered, (n) => n === 4, { label: "collapse-all shows 4 pads" });
    await bClick("#expand-all");
    await waitFor(async () => (await floor()).rendered, (n) => n === 9, { label: "expand-all shows 9 machines" });
    await bClick("#mmCollapse");
    expect(await bJsText("document.querySelector('#mmCollapse').getAttribute('aria-expanded')")).toBe("false");
    await bClick("#mmCollapse");
    expect(await bJsText("document.querySelector('#mmCollapse').getAttribute('aria-expanded')")).toBe("true");
    await bClick("#themeBtn");
    await waitFor(async () => await bJsText("document.documentElement.getAttribute('data-theme')"), (v) => v === "light", {
      label: "Day toggle flips the theme",
    });
    await bClick("#themeBtn");
    // Server-only affordances answer honestly instead of dying silent.
    await bClick("#relayout");
    await waitFor(async () => await text("#status-notice"), (v) => v === "Relayout needs a live server", {
      label: "relayout answers with its reason",
    });
    // No socket, past the 1 s reconnect horizon: poll the readout
    // for 1.5 s and fail if it ever leaves frozen, and the console
    // guard below proves no WebSocket constructor ever ran (from
    // file:// its URL is invalid, so any attempt would throw
    // synchronously into the console).
    const horizon = Date.now();
    for (;;) {
      expect(await text("#conn-state")).toBe("preview — frozen");
      if (Date.now() - horizon > 1500) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 90000);

  // Value: protects=V10 (version mismatch is a full page naming both
  // versions, never a half-render); fails_when=the guard drops or
  // the page half-boots.
  test("a rewritten snapshot version shows only the mismatch page", async () => {
    await bViewport("1440x900");
    await bGoto(mismatchUrl);
    await waitFor(
      async () => {
        try {
          return await bJsText("document.querySelector('#preview-error').textContent ?? ''");
        } catch {
          return "";
        }
      },
      (v) => v.length > 0,
      { timeoutMs: 30000, label: "mismatch page appears" },
    );
    const msg = await bJsText("document.querySelector('#preview-error').textContent");
    expect(msg).toContain("999");
    expect(msg).toContain("v1");
    expect(msg).toContain("Re-export the preview");
    expect(await bJs<boolean>("document.querySelector('#floor') === null")).toBe(true);
    expect((await floor()).version).toBe(0);
    await bConsoleClear();
  }, 60000);
});
