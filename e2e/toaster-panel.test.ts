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

type ToasterProbe = { open: boolean; bay: boolean; aggregate: string; recorded: boolean; cae: string; stages: string[] };
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

  test("stage bay is on the floor before any click: machines, gate, invite of honesty", async () => {
    const probe = await toaster();
    expect(probe.bay).toBe(true);
    expect(probe.open).toBe(false);
    const bay = await bJsText("document.querySelector('#stageBay').textContent");
    expect(bay).toContain("ASK");
    expect(bay).toContain("PROVE");
    expect(bay).toContain("CAE 86431019567246");
    expect(bay).toContain("Recorded proof · not live");
    expect(bay).not.toContain("20417277529");
    // Clicking a bay machine opens the detail panel for that story.
    await bClick("[data-stage='prove']");
    await waitFor(async () => (await toaster()).open, (v) => v === true, { label: "bay click opens panel" });
    const detail = await bJsText("document.querySelector('#toasterDetail').textContent");
    expect(detail).toContain("Proving output");
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

  test("clicking a stage machine shows the proving input and output", async () => {
    // Scoped to the panel: the floor bay carries its own stage row.
    await bClick("#toasterPanel [data-stage='prove']");
    const detail = await bJsText("document.querySelector('#toasterDetail').textContent");
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
