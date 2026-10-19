/**
 * Floor E2E: the real app in headless Chromium over a deterministic
 * fixture repo, asserting rendered behavior through the
 * window.__floor/__belts/__search probes plus DOM reads.
 *
 * Gated on ARTIFEX_E2E=1 (`bun run e2e`): the default `bun test` stays
 * browser-free. Serial by design — the driver addresses the active tab,
 * so this stays one file. Every test reloads the floor first (fresh
 * state, and proof against the driver daemon restarting mid-run, which
 * was observed during development).
 *
 * Note: the driver's console buffer is daemon-wide, so a stray open tab
 * hitting a dead server would poison the per-test console check with
 * foreign errors. beforeAll closes every tab first, so local runs are
 * immune too (CI uses a fresh daemon regardless).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "../server/index.ts";
import type { SpawnFn } from "../agents/muse-adapter.ts";
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
  bReload,
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
  endpoints: [string, string][];
  routed: number;
  routeMs: number;
  lanes: number;
  overflow: number;
  degraded: boolean;
  coalesced: number;
};
type SearchProbe = { query: string; matches: number; shown: number; selected: string | null };

const floor = () => bJs<FloorProbe>("window.__floor");
const belts = () => bJs<BeltsProbe>("window.__belts");
const searchProbe = () => bJs<SearchProbe>("window.__search");
const text = (sel: string) => bJsText(`document.querySelector('${sel}').textContent`);
// Screenshots must land where the driver may write: it confines paths
// to /tmp and the workspace. RUNNER_TEMP is neither, and os.tmpdir()
// still honors TMPDIR/TMP/TEMP overrides a runner may set outside
// the allowlist — so the workspace itself (gitignored .artifex/e2e),
// which the CI artifact upload reads from the same place.
const failDir = () => {
  const dir = join(import.meta.dir, "..", ".artifex", "e2e");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const FIXTURE = join(import.meta.dir, "fixtures", "mini-floor");
// Oldest → newest; src/main.ts newest so landOnRecent lands on src:
// rendered = 4 src machines + 3 collapsed pads = 7.
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

let repo = "";
let server: FloorServer | undefined;

/** Fixed viewport + full reload + wait for first snapshot. Idempotent. */
async function loadFloor(): Promise<void> {
  await bViewport("1440x900");
  await bGoto(server!.url);
  await waitFor(
    async () => {
      try {
        return (await floor()).version;
      } catch {
        return 0; // blank tab / mid-load: keep polling
      }
    },
    (v) => v > 0,
    { timeoutMs: 30000, label: "floor version > 0" },
  );
  await bConsoleClear();
}

/** Expand all zones and fit the whole floor; wait for belts to draw. */
async function showWholeFloor(): Promise<void> {
  await bClick("#expand-all");
  await waitFor(async () => (await floor()).rendered, (n) => n === 9, { label: "expand-all renders 9" });
  await bClick("#zoomLabel");
  await waitFor(async () => (await belts()).drawn, (n) => n === 4, { label: "fit-all draws 4 belts" });
}

describe.skipIf(!process.env.ARTIFEX_E2E)("floor e2e", () => {
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "artifex-e2e-"));
    cpSync(FIXTURE, repo, { recursive: true });
    const base = Date.now() - 120_000;
    MTIME_ORDER.forEach((f, i) => {
      const t = new Date(base + i * 1000);
      utimesSync(join(repo, f), t, t);
    });
    // Agent off: the guard tests assert the explicit refusal, and CI
    // has no muse binary — dispatch must be deterministic here. The
    // live ghost flow has its own describe below with a fake agent.
    server = await createFloorServer({ repo, port: 0, agent: false });
    await bCloseAllTabs();
    await bNewtab();
    await loadFloor();
  }, 90000);

  beforeEach(loadFloor, 45000);

  // Plan §4 item 8: zero console errors after EVERY test. Highest-value
  // assertion in the file — catches WS/auth/bundle regressions.
  afterEach(async () => {
    let errors: string;
    try {
      errors = await bConsoleErrors();
    } catch (e) {
      throw new Error(`console read failed (daemon/tab died mid-test?): ${(e as Error).message}`);
    }
    if (!errors.includes("(no console errors)")) {
      const shot = join(failDir(), `artifex-e2e-console-${Date.now()}.png`);
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
    server?.stop();
    server = undefined;
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = "";
  });

  // Value: protects=boot-to-pixels wiring (snapshot→probes→chrome);
  // fails_when=auth/token injection, snapshot shape, or landing regresses.
  test("load renders the fixture floor", async () => {
    const f = await floor();
    expect(f.version).toBeGreaterThan(0);
    expect(f.total).toBe(9);
    expect(f.zones).toBe(4);
    expect(f.rendered).toBe(7);
    expect(f.draws).toBeGreaterThan(0);
    expect(await text("#status-count")).toBe("7 of 9 machines");
    expect(await bJs<boolean>("document.querySelector('#search').disabled")).toBe(false);
    expect(await text("#last-change")).toContain("src/main.ts");
    expect(await bJs<number>("window.innerWidth")).toBe(1440);
    expect(await bJs<number>("window.innerHeight")).toBe(900);
    // The site-plan minimap paints zones, not a blank canvas.
    const minimapPaints = await bJs<boolean>(
      "(() => { const c = document.querySelector('#minimap'); const d = c.getContext('2d')" +
        ".getImageData(0, 0, c.width, c.height).data; let s = 0;" +
        " for (let i = 0; i < d.length; i += 401) s += d[i]; return s > 0; })()",
    );
    expect(minimapPaints).toBe(true);
    await bScreenshot(join(failDir(), `artifex-e2e-smoke-${Date.now()}.png`));
  }, 30000);

  // Value: protects=zoom-band gating (far rollup vs mid/near paths);
  // fails_when=zoomBand thresholds, stepZoom, or fit-all math drifts.
  test("zoom bands gate belt rendering", async () => {
    await showWholeFloor();
    const fitScale = (await floor()).cam.scale;
    const fitBand = (await belts()).band;
    expect((await belts()).routed).toBe(4);

    for (let i = 0; i < 14 && (await belts()).band !== "far"; i++) await bClick("#zoomOut");
    expect((await belts()).band).toBe("far");
    expect((await belts()).aggregates).toBe(1); // the single src→lib cross-zone pair
    expect((await belts()).drawn).toBe(0); // far shows the rollup only
    expect((await belts()).routed).toBe(4); // routing cache intact regardless of view
    expect(await text("#zoomLabel")).toBe(`${Math.round((await floor()).cam.scale * 100)}%`);

    for (let i = 0; i < 14 && (await belts()).band === "far"; i++) await bClick("#zoomIn");
    expect((await belts()).band).toBe("mid");
    expect((await belts()).drawn).toBeGreaterThan(0);
    expect(await text("#zoomLabel")).toBe(`${Math.round((await floor()).cam.scale * 100)}%`);

    for (let i = 0; i < 14 && (await belts()).band !== "near"; i++) await bClick("#zoomIn");
    expect((await belts()).band).toBe("near");
    expect((await floor()).cam.scale).toBeGreaterThan(1.25);
    expect(await text("#zoomLabel")).toBe(`${Math.round((await floor()).cam.scale * 100)}%`);

    await bClick("#zoomLabel");
    await waitFor(async () => (await floor()).cam.scale, (s) => Math.abs(s - fitScale) < 1e-9, {
      label: "fit-all restores scale",
    });
    expect((await belts()).band).toBe(fitBand);
  }, 60000);

  // Value: protects=zone expand/collapse accounting (rendered count);
  // fails_when=pad/machine counting or expanded-set handling breaks.
  test("zone expand and collapse change the rendered count", async () => {
    await bClick("#collapse-all");
    await waitFor(async () => (await floor()).rendered, (n) => n === 4, { label: "collapse-all shows 4 pads" });
    await bClick("#expand-all");
    await waitFor(async () => (await floor()).rendered, (n) => n === 9, { label: "expand-all shows 9 machines" });
  }, 30000);

  // Value: protects=search-to-file (works past the block cap) + dispatch
  // addressing; fails_when=search index, jumpTo, or prompt wiring breaks.
  test("search jumps to a file", async () => {
    await bFill("#search", "store");
    const s = await waitFor(searchProbe, (p) => p.matches > 0, { label: "search matches" });
    expect(s.query).toBe("store");
    expect(s.matches).toBe(1);
    expect(s.shown).toBe(1);
    expect(await bJs<boolean>("document.querySelector('#search-results').hidden")).toBe(false);
    expect(await bJs<number>("document.querySelectorAll('#search-results li').length")).toBeGreaterThanOrEqual(1);
    await bPress("Enter");
    await waitFor(async () => (await searchProbe()).selected, (v) => v === "lib/store.ts", {
      label: "jump selects lib/store.ts",
    });
    expect(await text("#insp-path")).toContain("lib/store.ts");
    expect((await floor()).cam.scale).toBeGreaterThanOrEqual(1.5);
    expect(await bJsText("document.querySelector('#prompt').value")).toMatch(/^@lib\/store\.ts /);
  }, 30000);

  // Value: protects=belt probe shape + selection isolation + empty-space
  // deselect; fails_when=router output, isolation, or canvas hit-test breaks.
  test("belts render and selection isolates them", async () => {
    await showWholeFloor();
    const b = await belts();
    expect(b.belts).toBe(4);
    expect(b.routed).toBe(4);
    expect(b.drawn).toBe(4);
    expect(b.endpoints).toHaveLength(4);
    for (const [a, c] of b.endpoints) {
      expect(a).toMatch(/^b\d+$/);
      expect(c).toMatch(/^b\d+$/);
    }
    await bFill("#search", "store");
    await bPress("Enter");
    await waitFor(async () => (await belts()).isolated, (v) => v === true, { label: "selection isolates belts" });
    // Deselect with an empty-space canvas click. Self-validating: an
    // unchanged rendered count proves the click missed machines AND zone
    // pads (a hit would select or toggle expansion), so this cannot pass
    // vacuously if the fixture layout ever shifts under the click point.
    const before = (await floor()).rendered;
    await bJsText(
      "(() => { const c = document.querySelector('#floor'); const r = c.getBoundingClientRect(); " +
        "c.dispatchEvent(new PointerEvent('pointerup', {clientX: r.right - 20, clientY: r.bottom - 20, bubbles: true})); " +
        "return 'ok'; })()",
    );
    await waitFor(async () => (await searchProbe()).selected, (v) => v === null, {
      label: "empty click clears selection",
    });
    expect((await belts()).isolated).toBe(false);
    expect((await floor()).rendered).toBe(before);
    expect(await bJs<boolean>("document.querySelector('#inspector-empty').hidden")).toBe(false);
  }, 30000);

  // Value: protects=legend toggle + dismissal persistence;
  // fails_when=store wrapper, boot restore, or dock wiring breaks.
  test("legend toggles and dismissal persists", async () => {
    const display = () => bJsText("document.querySelector('#legend').style.display");
    await bJsText("localStorage.clear()");
    await bReload();
    await loadFloor();
    expect(await display()).toBe("block");
    await bClick("#dockBtn");
    expect(await display()).toBe("none");
    await bClick("#dockBtn");
    expect(await display()).toBe("block");
    await bClick("#legendClose");
    expect(await display()).toBe("none");
    expect(await bJsText("localStorage.getItem('artifex-legend')")).toBe("hidden");
    await bReload();
    await loadFloor();
    expect(await display()).toBe("none");
  }, 60000);

  // Value: protects=runs panel toggle + honest empty ledger +
  // Escape/close dismissal; fails_when=panel wiring, the empty
  // copy, or the Esc cascade breaks.
  test("runs panel toggles with the empty ledger", async () => {
    const hidden = () => bJs<boolean>("document.querySelector('#runsPanel').hidden");
    expect(await hidden()).toBe(true);
    await bClick("#runsBtn");
    expect(await hidden()).toBe(false);
    expect(await text("#runsList")).toContain("No runs yet this boot");
    expect(await text("#runDetail")).toContain("Select a run");
    expect((await floor()).runs).toBe(0);
    await bPress("Escape");
    expect(await hidden()).toBe(true);
    await bClick("#runsBtn");
    await bClick("#runsClose");
    expect(await hidden()).toBe(true);
    expect(await bJsText("document.activeElement.id")).toBe("runsBtn");
  }, 60000);

  // Value: protects=inspector rows + file-content round trip + dispatch
  // guard notice; fails_when=open-file WS flow or dispatch stub breaks.
  test("inspector shows file details and dispatch guards", async () => {
    await bFill("#search", "main");
    await bPress("Enter");
    await waitFor(async () => (await searchProbe()).selected, (v) => v === "src/main.ts", {
      label: "jump selects src/main.ts",
    });
    expect(await text("#insp-lines")).not.toBe("");
    expect(await text("#insp-bytes")).not.toBe("");
    expect(await text("#insp-band")).not.toBe("");
    expect(await text("#insp-parse")).toBe("ok");
    await waitFor(async () => bJs<boolean>("document.querySelector('#insp-content').hidden"), (v) => v === false, {
      label: "file preview lands",
    });
    expect(await text("#insp-content")).toContain("helper");
    await bFill("#prompt", "@src/main.ts hi");
    await bClick("#dispatchSend");
    await waitFor(async () => text("#status-notice"), (t) => t.includes("Dispatch needs an agent session"), {
      label: "dispatch guard notice",
    });
  }, 30000);

  // Value: protects=Dayshift preview toggle + canvas token repaint;
  // fails_when=theme dataset, label sync, or refreshTokens breaks.
  test("day toggle flips the theme and repaints", async () => {
    const theme = () => bJsText("document.documentElement.dataset.theme");
    const d0 = (await floor()).draws;
    await bClick("#themeBtn");
    await waitFor(theme, (t) => t === "light", { label: "theme flips to light" });
    expect(await text("#themeBtn")).toBe("Night");
    await waitFor(async () => (await floor()).draws, (n) => n > d0, { label: "canvas repaints on theme change" });
    await bClick("#themeBtn");
    await waitFor(theme, (t) => t === "dark", { label: "theme flips back to dark" });
    expect(await text("#themeBtn")).toContain("Day");
  }, 30000);

  // Value: protects=watcher→patch→inspector live path (the only
  // timing-sensitive test); fails_when=watch events, patch apply, or
  // preview refresh breaks. One file-rewrite retry, then fails honestly.
  test("live file edits land on the floor", async () => {
    await bFill("#search", "util");
    await bPress("Enter");
    await waitFor(async () => (await searchProbe()).selected, (v) => v === "src/util.ts", {
      label: "jump selects src/util.ts",
    });
    const linesBefore = await text("#insp-lines");
    const v0 = (await floor()).version;
    appendFileSync(join(repo, "src/util.ts"), "export const live = 1;\n");
    try {
      await waitFor(async () => (await floor()).version, (v) => v > v0, {
        timeoutMs: 15000,
        label: "watcher patch lands",
      });
    } catch {
      appendFileSync(join(repo, "src/util.ts"), "export const live2 = 2;\n");
      await waitFor(async () => (await floor()).version, (v) => v > v0, {
        timeoutMs: 15000,
        label: "watcher patch lands (retry)",
      });
    }
    expect(await text("#last-change")).toContain("src/util.ts");
    await waitFor(async () => text("#insp-lines"), (t) => t !== linesBefore, { label: "inspector refreshes on patch" });
    // A patch under an open match list re-renders it instead of
    // stranding stale rows.
    await bFill("#search", "util");
    await waitFor(searchProbe, (p) => p.matches > 0, { label: "search matches again" });
    const v1 = (await floor()).version;
    appendFileSync(join(repo, "src/util.ts"), "export const live3 = 3;\n");
    await waitFor(async () => (await floor()).version, (v) => v > v1, {
      timeoutMs: 15000,
      label: "second patch lands under the open list",
    });
    expect(await bJs<boolean>("document.querySelector('#search-results').hidden")).toBe(false);
    expect((await searchProbe()).matches).toBeGreaterThan(0);
  }, 90000);

  // Value: protects=canvas drag-pan wiring (pointerdown/move/up →
  // camera translate, no selection side effects); fails_when=the
  // drag math or the wasDrag guard breaks (pans select machines).
  test("dragging the canvas pans the camera", async () => {
    const before = await floor();
    // Synthetic pointers are never "active", and Chrome throws on
    // setPointerCapture for them — stub the call (fresh page per
    // test, so no restore) to test the drag math without the noise.
    await bJsText(
      "(() => { const c = document.querySelector('#floor');" +
        " HTMLCanvasElement.prototype.setPointerCapture = () => {};" +
        " const r = c.getBoundingClientRect();" +
        " const cx = r.left + r.width / 2, cy = r.top + r.height / 2;" +
        " c.dispatchEvent(new PointerEvent('pointerdown', {clientX: cx, clientY: cy, bubbles: true}));" +
        " c.dispatchEvent(new PointerEvent('pointermove', {clientX: cx + 60, clientY: cy + 40, bubbles: true}));" +
        " c.dispatchEvent(new PointerEvent('pointerup', {clientX: cx + 60, clientY: cy + 40, bubbles: true}));" +
        " return 'ok'; })()",
    );
    const after = await waitFor(floor, (f) => f.cam.x !== before.cam.x, { label: "pan moves the camera" });
    expect(after.cam.x).toBeCloseTo(before.cam.x + 60, 9);
    expect(after.cam.y).toBeCloseTo(before.cam.y + 40, 9);
    expect(after.cam.scale).toBe(before.cam.scale);
    expect(after.rendered).toBe(before.rendered);
    expect((await searchProbe()).selected).toBeNull();
  }, 30000);

  // Value: protects=wheel-zoom wiring (wheel → zoomAround at the
  // cursor); fails_when=the listener or zoom math breaks (scroll
  // does nothing or jumps the camera).
  test("wheeling over the canvas zooms at the cursor", async () => {
    const before = await floor();
    await bJsText(
      "(() => { const c = document.querySelector('#floor'); const r = c.getBoundingClientRect();" +
        " c.dispatchEvent(new WheelEvent('wheel', {clientX: r.left + r.width / 2," +
        " clientY: r.top + r.height / 2, deltaY: -100, bubbles: true, cancelable: true}));" +
        " return 'ok'; })()",
    );
    const after = await waitFor(floor, (f) => f.cam.scale !== before.cam.scale, { label: "wheel changes scale" });
    expect(after.cam.scale).toBeGreaterThan(before.cam.scale);
    expect(await text("#zoomLabel")).toBe(`${Math.round(after.cam.scale * 100)}%`);
  }, 30000);

  // Value: protects=worker/follow wiring (jump to the newest change,
  // follow toggle state); fails_when=jumpToRecent breaks (button
  // dead) or the toggle desyncs from its aria-pressed.
  test("worker jumps to the newest file; follow toggles", async () => {
    for (let i = 0; i < 3; i++) await bClick("#zoomOut");
    const away = await floor();
    await bClick("#workerBtn");
    const landed = await waitFor(floor, (f) => f.cam.x !== away.cam.x || f.cam.y !== away.cam.y, {
      label: "worker moves the camera",
    });
    expect(landed.cam.scale).toBe(away.cam.scale);
    const pressed = () => bJsText("document.querySelector('#followBtn').getAttribute('aria-pressed')");
    expect(await pressed()).toBe("false");
    await bClick("#followBtn");
    await waitFor(pressed, (v) => v === "true", { label: "follow arms" });
    await bClick("#followBtn");
    await waitFor(pressed, (v) => v === "false", { label: "follow disarms" });
  }, 30000);

  // Value: protects=chrome toggles (inspector drawer, site-plan
  // collapse); fails_when=the class/aria wiring breaks (buttons dead
  // or state desynced for assistive tech).
  test("inspector and site-plan toggles flip state both ways", async () => {
    const insp = () => bJsText("document.querySelector('#inspBtn').getAttribute('aria-expanded')");
    const noInsp = () => bJs<boolean>("document.querySelector('#floor-main').classList.contains('no-insp')");
    expect(await insp()).toBe("true");
    expect(await noInsp()).toBe(false);
    await bClick("#inspBtn");
    await waitFor(insp, (v) => v === "false", { label: "inspector closes" });
    expect(await noInsp()).toBe(true);
    await bClick("#inspBtn");
    await waitFor(insp, (v) => v === "true", { label: "inspector reopens" });
    expect(await noInsp()).toBe(false);
    const mm = () => bJsText("document.querySelector('#mmCollapse').getAttribute('aria-expanded')");
    const collapsed = () => bJs<boolean>("document.querySelector('.minimap').classList.contains('collapsed')");
    expect(await mm()).toBe("true");
    await bClick("#mmCollapse");
    await waitFor(mm, (v) => v === "false", { label: "site plan collapses" });
    expect(await collapsed()).toBe(true);
    await bClick("#mmCollapse");
    await waitFor(mm, (v) => v === "true", { label: "site plan reopens" });
    expect(await collapsed()).toBe(false);
  }, 30000);

  // Value: protects=prompt Enter parity with the Send button (same
  // dispatch guard); fails_when=the keydown wiring breaks (Enter in
  // the prompt does nothing).
  test("Enter in the prompt hits the dispatch guard", async () => {
    await bFill("#prompt", "@src/main.ts hi");
    await bPress("Enter");
    await waitFor(async () => text("#status-notice"), (t) => t.includes("Dispatch needs an agent session"), {
      label: "dispatch guard notice",
    });
  }, 30000);

  // Value: protects=narrow-viewport chrome (theme label shortens, the
  // site plan yields to the legend, follow disarms);
  // fails_when=the matchMedia wiring breaks (phone layout keeps
  // desktop chrome).
  test("a narrow viewport collapses chrome", async () => {
    await bJsText("localStorage.clear()");
    await bReload();
    await loadFloor();
    await bViewport("600x900");
    await waitFor(async () => text("#themeBtn"), (t) => t === "Day", { label: "theme label shortens" });
    expect(await bJs<boolean>("document.querySelector('.minimap').classList.contains('collapsed')")).toBe(true);
    expect(await bJsText("document.querySelector('#followBtn').getAttribute('aria-pressed')")).toBe("false");
    // Phone sheets dismiss topmost-first: legend before map.
    const legendShown = () => bJsText("document.querySelector('#legend').style.display");
    expect(await legendShown()).toBe("block");
    await bPress("Escape");
    await waitFor(legendShown, (v) => v === "none", { label: "Escape dismisses the legend sheet" });
  }, 60000);

  // Value: protects=search Escape (closes the match list without
  // clearing the query); fails_when=the keydown wiring breaks (the
  // list sticks open).
  test("Escape closes the search list", async () => {
    const hidden = () => bJs<boolean>("document.querySelector('#search-results').hidden");
    await bFill("#search", "store");
    await waitFor(searchProbe, (p) => p.matches > 0, { label: "search matches" });
    expect(await hidden()).toBe(false);
    await bPress("Escape");
    await waitFor(hidden, (v) => v === true, { label: "Escape closes the list" });
  }, 30000);

  // Value: protects=relayout button wiring (click → server
  // round trip → fresh snapshot repaint, same floor);
  // fails_when=the click wiring breaks (dead button).
  test("relayout repaints the same floor", async () => {
    const before = await floor();
    await bClick("#relayout");
    const after = await waitFor(floor, (f) => f.draws > before.draws, { label: "relayout repaints" });
    expect(after.total).toBe(before.total);
    expect(after.zones).toBe(before.zones);
    expect(after.rendered).toBe(before.rendered);
  }, 30000);

  // Value: protects=search blur (leaving the field closes the match
  // list); fails_when=the blur wiring breaks (the list sticks open
  // over the floor).
  test("leaving search closes the match list", async () => {
    const hidden = () => bJs<boolean>("document.querySelector('#search-results').hidden");
    await bFill("#search", "store");
    await waitFor(searchProbe, (p) => p.matches > 0, { label: "search matches" });
    expect(await hidden()).toBe(false);
    // A real trusted click elsewhere moves focus (synthetic events
    // don't); fit-all is a harmless side effect here.
    await bClick("#zoomLabel");
    await waitFor(hidden, (v) => v === true, { label: "blur closes the list" });
  }, 30000);

  // Value: protects=drawer-handle parity with the inspector toggle
  // (same wiring, second button); fails_when=the delegation breaks
  // (handle dead on desktop).
  test("the drawer handle toggles the inspector", async () => {
    const insp = () => bJsText("document.querySelector('#inspBtn').getAttribute('aria-expanded')");
    expect(await insp()).toBe("true");
    await bClick("#drawerHandle");
    await waitFor(insp, (v) => v === "false", { label: "handle closes the inspector" });
    await bClick("#drawerHandle");
    await waitFor(insp, (v) => v === "true", { label: "handle reopens the inspector" });
  }, 30000);

  // Value: protects=search arrow-key navigation (highlight
  // follows arrows, Enter jumps to the highlight);
  // fails_when=searchActive wiring breaks (arrows dead or Enter
  // jumps to the wrong row).
  test("arrow keys move the search highlight", async () => {
    await bFill("#search", "s");
    await waitFor(searchProbe, (p) => p.matches > 1, { label: "search matches several" });
    const second = await bJsText("document.querySelector('#search-opt-1').textContent");
    expect(second.length).toBeGreaterThan(0);
    await bPress("ArrowDown");
    await bPress("ArrowDown");
    expect(await bJsText("document.querySelector('#search').getAttribute('aria-activedescendant')")).toBe(
      "search-opt-1",
    );
    await bPress("Enter");
    await waitFor(async () => (await searchProbe()).selected, (v) => v === second, {
      label: "Enter jumps to the highlighted row",
    });
  }, 30000);

  // Value: protects=empty-floor robustness (deleting every file:
  // zero-state probes, no client exceptions, worker harmless) plus
  // live refill; fails_when=zero zones produce NaN cameras or draw
  // exceptions (the per-test console check is the guard).
  test("emptying the floor leaves a healthy zero state", async () => {
    for (const f of MTIME_ORDER) unlinkSync(join(repo, f));
    const empty = await waitFor(floor, (f) => f.total === 0, { label: "floor empties", timeoutMs: 20000 });
    expect(empty.rendered).toBe(0);
    expect((await searchProbe()).matches).toBe(0);
    await bClick("#workerBtn");
    await bClick("#zoomLabel");
    expect((await floor()).total).toBe(0);
    // Refill so later tests see the fixture again (contents only
    // need to exist; the server re-derives everything live).
    for (const f of MTIME_ORDER) {
      if (f.endsWith(".bin")) writeFileSync(join(repo, f), Buffer.from([0x00, 0x01]));
      else if (f.endsWith(".json")) writeFileSync(join(repo, f), "{}\n");
      else if (f.endsWith(".md")) writeFileSync(join(repo, f), "# restored\n");
      else writeFileSync(join(repo, f), "export {};\n");
    }
    await waitFor(floor, (f) => f.total === 9, { label: "floor refills to 9", timeoutMs: 20000 });
  }, 60000);

  // Value: protects=session re-entry over a live server (cheap
  // reconnect); fails_when=boot/snapshot/auth breaks on fresh tabs.
  test("a fresh tab reconnects to the live server", async () => {
    await bClosetab();
    await bNewtab();
    await loadFloor();
    expect((await floor()).total).toBe(9);
    expect((await floor()).version).toBeGreaterThan(0);
  }, 60000);
});

// Ghost layer end to end with a fake agent replaying the measured
// muse JSONL shapes (the real muse run is verified live, not in CI).
// Own server + repo: dispatch needs an agent, and the main suite
// above runs agentless on purpose.
describe.skipIf(!process.env.ARTIFEX_E2E)("floor e2e: ghost dispatch", () => {
  const SESSION = "00000000-0000-4000-8000-0000000000bb";
  let ghostRepo = "";
  let ghostServer: FloorServer | undefined;
  let pushLine: ((line: string) => void) | undefined;
  let endRun: ((code: number) => void) | undefined;

  const fakeSpawn: SpawnFn = () => {
    const queue: string[] = [];
    let done = false;
    let waiter: (() => void) | undefined;
    let resolveExit: ((code: number | null) => void) | undefined;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    pushLine = (line) => {
      queue.push(line);
      waiter?.();
    };
    endRun = (code) => {
      done = true;
      waiter?.();
      resolveExit?.(code);
    };
    return {
      stdout: (async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>((r) => {
            waiter = r;
          });
        }
      })(),
      stderr: (async function* () {})(),
      exited,
      killGroup: (signal) => {
        if (signal === "SIGKILL") resolveExit?.(137);
      },
    };
  };

  beforeAll(async () => {
    ghostRepo = mkdtempSync(join(tmpdir(), "artifex-e2e-ghost-"));
    writeFileSync(join(ghostRepo, "README.md"), "# ghost e2e\n");
    ghostServer = await createFloorServer({
      repo: ghostRepo,
      port: 0,
      agent: { spawnFn: fakeSpawn, sessionId: SESSION, timeoutMs: 120_000 },
    });
    server = ghostServer; // loadFloor/probes address the module server
    await bNewtab();
    await loadFloor();
  }, 90000);

  afterAll(async () => {
    ghostServer?.stop();
    await bClosetab();
    rmSync(ghostRepo, { recursive: true, force: true });
  });

  // Value: protects=the dispatch → ghost → solidify loop in the real
  // browser (SEND streams a prompt, planned paths render as ghosts,
  // the landed file solidifies, the worker chip tracks the run);
  // fails_when=dispatch wiring, patch application, or probe breaks.
  test("dispatch shows a ghost that solidifies when the file lands", async () => {
    await bFill("#prompt", "create hello.txt");
    await bClick("#dispatchSend");
    await waitFor(floor, (f) => f.agent === "working", { label: "agent working", timeoutMs: 15000 });
    expect(await text("#conn-state")).toContain("muse · working");
    pushLine!(
      JSON.stringify({
        payload_type: "todo.snapshot.updated",
        stream: { kind: "session", id: SESSION },
        payload: {
          facts: {
            revision_id: 1,
            items: [{ index: 0, status: "in_progress", text: "Create hello.txt" }],
          },
        },
      }),
    );
    await waitFor(floor, (f) => f.ghosts === 1, { label: "ghost renders", timeoutMs: 15000 });
    writeFileSync(join(ghostRepo, "hello.txt"), "hello\n");
    await waitFor(floor, (f) => f.ghosts === 0 && f.total === 2, {
      label: "ghost solidifies into a building",
      timeoutMs: 20000,
    });
    pushLine!(JSON.stringify({ payload_type: "run.terminal.completed" }));
    endRun!(0);
    await waitFor(floor, (f) => f.agent === "done", { label: "agent done", timeoutMs: 15000 });
    expect(ghostServer!.eventLog.some((e) => e.type === "file-written" && e.provenance === "intended")).toBe(true);
  }, 60000);
});
