/**
 * Toaster panel E2E (T3): the real floor in headless Chromium over
 * the mini-floor fixture, asserting the human panel renders the
 * archived gate proof (`e2e/toaster-gate.live.json`, served by the
 * server as a labeled replay): four proven stage machines, the
 * real test CAE, RECORDED PROOF chrome, the airlock sentence, and
 * the strip aggregate — with zero console errors.
 *
 * Gated on ARTIFEX_E2E=1 like the rest of `bun run e2e`. This
 * never calls ARCA: the proof on screen is the frozen T2 record.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "../server/index.ts";
import {
  bClick,
  bCloseAllTabs,
  bConsoleClear,
  bConsoleErrors,
  bGoto,
  bJs,
  bJsText,
  bNewtab,
  bViewport,
  waitFor,
} from "./browse.ts";

type ToasterProbe = {
  open: boolean;
  bay: boolean;
  pad: boolean;
  detail: string;
  story: { pad: { x: number; y: number; w: number; h: number }; stages: { id: string; x: number; y: number; w: number; h: number }[] } | null;
  aggregate: string;
  recorded: boolean;
  cae: string;
  stages: string[];
};
type FloorProbe = { version: number };

const toaster = () => bJs<ToasterProbe>("window.__toaster");
const FIXTURE = join(import.meta.dir, "fixtures", "mini-floor");

let repo = "";
let server: FloorServer | undefined;

describe.skipIf(!process.env.ARTIFEX_E2E)("toaster panel e2e", () => {
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "artifex-toaster-e2e-"));
    cpSync(FIXTURE, repo, { recursive: true });
    server = await createFloorServer({ repo, port: 0, agent: false });
    await bCloseAllTabs();
    await bNewtab();
    await bViewport("1440x900");
    await bGoto(server.url);
    await waitFor(
      async () => {
        try {
          return (await bJs<FloorProbe>("window.__floor")).version;
        } catch {
          return 0;
        }
      },
      (v) => v > 0,
      { timeoutMs: 30000, label: "floor version > 0" },
    );
    await bConsoleClear();
  }, 90000);

  afterEach(async () => {
    const errors = await bConsoleErrors();
    if (!errors.includes("(no console errors)")) {
      throw new Error(`console errors: ${errors}`);
    }
  });

  afterAll(async () => {
    server?.stop();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("story is the first frame: pad drawn on load, each stage opens its own card", async () => {
    // No fit click: story-first landing frames the bay on load.
    await waitFor(async () => (await toaster()).pad, (v) => v === true, { label: "story pad in first frame" });
    const probe = await toaster();
    expect(probe.open).toBe(false);
    expect(probe.story?.stages.map((s) => s.id)).toEqual(["ask", "build", "file", "prove"]);
    expect(probe.stages).toEqual(["proven", "proven", "proven", "proven"]);
    const clickStage = (id: string) =>
      bJsText(
        "(() => { const t = window.__toaster; const f = window.__floor; const r = document.querySelector('#floor').getBoundingClientRect();" +
          ` const s = t.story.stages.find((s) => s.id === '${id}');` +
          " const cx = r.left + (s.x + s.w / 2) * f.cam.scale + f.cam.x; const cy = r.top + (s.y + s.h / 2) * f.cam.scale + f.cam.y;" +
          " const c = document.querySelector('#floor');" +
          " for (const type of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, bubbles: true })); return 'clicked'; })()",
      );
    await clickStage("ask");
    await waitFor(async () => (await toaster()).detail, (v) => v === "ask", { label: "ask detail" });
    const askDetail = await bJsText("document.querySelector('#toasterDetail').textContent");
    expect(askDetail).toContain("factura C");
    expect(askDetail).not.toContain("86431019567246");
    await clickStage("prove");
    await waitFor(async () => (await toaster()).detail, (v) => v === "prove", { label: "prove detail" });
    const proveDetail = await bJsText("document.querySelector('#toasterDetail').textContent");
    expect(proveDetail).toContain("86431019567246");
    expect(proveDetail).toContain("Proving output");
  });

  test("recorded gate proof renders proven machines, CAE, and replay chrome", async () => {
    if (!(await toaster()).open) await bClick("#toasterBtn");
    await waitFor(async () => (await toaster()).open, (v) => v === true, { label: "toaster open" });
    const probe = await toaster();
    expect(probe.aggregate).toBe("4 of 4 proven");
    expect(probe.recorded).toBe(true);
    expect(probe.cae).toBe("86431019567246");
    expect(probe.stages).toEqual(["proven", "proven", "proven", "proven"]);

    const panel = await bJsText("document.querySelector('#toasterPanel').textContent");
    expect(panel).toContain("Recorded proof");
    expect(panel).toContain("not live");
    expect(panel).toContain("86431019567246");
    expect(panel).toContain("Sending this invoice data to ARCA homologación, nothing else.");
    expect(panel).toContain("1 item crossed");
    expect(panel).toContain("Masked");
    // The sender's raw CUIT never reaches the page.
    expect(panel).not.toContain("20417277529");

    const chip = await bJsText("document.querySelector('#proof-chip').textContent");
    expect(chip).toContain("4 of 4 proven");
    const readout = await bJsText("document.querySelector('#ticker-readout').textContent");
    expect(readout).toContain("86431019567246");
  });

  test("clicking a stage machine shows its own card plus the proving record", async () => {
    // Scoped to the panel: the canvas carries its own stage row.
    await bClick("#toasterPanel [data-stage='prove']");
    await waitFor(async () => (await toaster()).detail, (v) => v === "prove", { label: "panel prove detail" });
    const detail = await bJsText("document.querySelector('#toasterDetail').textContent");
    expect(detail).toContain("Took in:");
    expect(detail).toContain("Proving input");
    expect(detail).toContain("Proving output");
    expect(detail).toContain("86431019567246");
  });
});

describe.skipIf(!process.env.ARTIFEX_E2E)("toaster failure scene e2e (T5)", () => {
  let failRepo = "";
  let failServer: FloorServer | undefined;
  const prevProofEnv = process.env.ARTIFEX_TOASTER_PROOF;

  beforeAll(async () => {
    process.env.ARTIFEX_TOASTER_PROOF = join(import.meta.dir, "fixtures", "toaster-rejected.json");
    failRepo = mkdtempSync(join(tmpdir(), "artifex-toaster-fail-"));
    cpSync(FIXTURE, failRepo, { recursive: true });
    failServer = await createFloorServer({ repo: failRepo, port: 0, agent: false });
    await bCloseAllTabs();
    await bNewtab();
    await bViewport("1440x900");
    await bGoto(failServer.url);
    await waitFor(
      async () => {
        try {
          return (await bJs<FloorProbe>("window.__floor")).version;
        } catch {
          return 0;
        }
      },
      (v) => v > 0,
      { timeoutMs: 30000, label: "failure floor version > 0" },
    );
    await bConsoleClear();
  }, 90000);

  afterAll(async () => {
    failServer?.stop();
    if (prevProofEnv === undefined) delete process.env.ARTIFEX_TOASTER_PROOF;
    else process.env.ARTIFEX_TOASTER_PROOF = prevProofEnv;
    if (failRepo) rmSync(failRepo, { recursive: true, force: true });
  });

  test("rejected invoice: PROVE failed, plain copy, next step, dismiss persists", async () => {
    const probe = await toaster();
    expect(probe.stages).toEqual(["proven", "proven", "proven", "failed"]);
    await bClick("#toasterBtn");
    await waitFor(async () => (await toaster()).open, (v) => v === true, { label: "failure panel open" });
    const panel = await bJsText("document.querySelector('#toasterPanel').textContent");
    expect(panel).toContain("ARCA rejected this invoice");
    expect(panel).toContain("Fix the invoice data shown below, then file again.");
    expect(panel).not.toContain("86431019567246");
    await bClick("[data-dismiss-error]");
    const after = await bJsText("document.querySelector('#toasterPanel').textContent");
    expect(after).not.toContain("ARCA rejected this invoice");
    const errors = await bConsoleErrors();
    if (!errors.includes("(no console errors)")) throw new Error(`console errors: ${errors}`);
  });
});
