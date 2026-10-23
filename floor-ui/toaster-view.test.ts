import { describe, expect, test } from "bun:test";
import type { ToasterProof } from "../server/toaster-proof.ts";
import { airlockFor, renderAirlock } from "./toaster-airlock.ts";
import { renderTicker, tickerEntries, tickerReadout } from "./toaster-ticker.ts";
import {
  buildToasterPanel,
  classifyError,
  labelBands,
  renderProofDetail,
  renderStage,
  renderStageDetail,
  renderToasterPanel,
} from "./toaster-view.ts";

const SEED: ToasterProof = {
  schema: "toaster-gate-1",
  env: "homologacion",
  stub: false,
  ranAt: "2026-10-23T15:03:23.326Z",
  cuitMasked: "20•••••••9",
  voucher: { ptoVta: 1, cbteTipo: 11, cbteDesde: 2, cbteHasta: 2, impTotal: 1000, monId: "PES" },
  cae: "86431019567246",
  caeFchVto: "20261102",
  resultado: "A",
  reproceso: "N",
  obs: [],
  errors: [],
  latencyMs: { status: 247, voucher: 134 },
};
const NOW = Date.parse(SEED.ranAt) + 60_000;

describe("toaster-view", () => {
  test("seed proof proves all four stages, aggregate 4 of 4", () => {
    const panel = buildToasterPanel([SEED], { recorded: true, now: NOW });
    expect(panel.provenCount).toBe(4);
    expect(panel.aggregateText).toBe("4 of 4 proven");
    expect(panel.stages.map((s) => s.lamp)).toEqual(["proven", "proven", "proven", "proven"]);
    expect(panel.stages.every((s) => s.solid)).toBe(true);
    expect(panel.recorded).toBe(true);
    expect(panel.error).toBeUndefined();
  });

  test("no proof is the empty bay: all ghost, all trying, no facts", () => {
    const panel = buildToasterPanel([], { recorded: false, now: NOW });
    expect(panel.provenCount).toBe(0);
    expect(panel.stages.every((s) => s.lamp === "trying" && !s.solid)).toBe(true);
    const html = renderToasterPanel(panel, new Set());
    expect(html).toContain("This bay is empty");
    expect(html).not.toContain("86431019567246");
  });

  test("rejected proof fails only PROVE, with rejected copy + next step", () => {
    const panel = buildToasterPanel([{ ...SEED, resultado: "R", cae: "", obs: [{ code: 10015, msg: "bad data" }] }], {
      recorded: true,
      now: NOW,
    });
    expect(panel.stages.map((s) => s.lamp)).toEqual(["proven", "proven", "proven", "failed"]);
    expect(panel.error?.kind).toBe("rejected");
    expect(panel.error?.next).toContain("file again");
  });

  test("transport fault fails FILE and PROVE and classifies bad cert", () => {
    const fault: ToasterProof = {
      ...SEED,
      resultado: "",
      cae: "",
      errors: [{ msg: "ns1:coe.notAuthorized: nope" }],
    };
    const panel = buildToasterPanel([fault], { recorded: true, now: NOW });
    expect(panel.stages.map((s) => s.lamp)).toEqual(["proven", "proven", "failed", "failed"]);
    expect(panel.error?.kind).toBe("bad-cert");
  });

  test("error taxonomy: timeout and unreachable classify by message", () => {
    const mk = (msg: string): ToasterProof => ({ ...SEED, resultado: "", cae: "", errors: [{ msg }] });
    expect(classifyError(mk("request timeout after 30s"))?.kind).toBe("timeout");
    expect(classifyError(mk("fetch failed: ECONNREFUSED"))?.kind).toBe("unreachable");
    expect(classifyError(mk("something odd"))?.kind).toBe("unknown");
    expect(classifyError(SEED)).toBeUndefined();
  });

  test("stub proof never claims a CAE: file/prove stay trying", () => {
    const panel = buildToasterPanel([{ ...SEED, stub: true, cae: "00000000000000" }], {
      recorded: false,
      now: NOW,
    });
    expect(panel.stages[2]!.lamp).toBe("trying");
    expect(panel.stages[3]!.lamp).toBe("trying");
    expect(panel.provenCount).toBe(2);
  });

  test("lamps carry shape + word, never color alone; no card language", () => {
    const html = renderStage(buildToasterPanel([SEED], { recorded: true, now: NOW }).stages[3]!);
    expect(html).toContain("✓");
    expect(html).toContain("PROVEN");
    expect(html).toContain("stage-nameplate");
    expect(html.toLowerCase()).not.toContain("card");
  });

  test("panel wears RECORDED PROOF chrome and shows the real CAE", () => {
    const html = renderToasterPanel(buildToasterPanel([SEED], { recorded: true, now: NOW }), new Set());
    expect(html).toContain("Recorded proof");
    expect(html).toContain("not live");
    expect(html).toContain("86431019567246");
    expect(html).toContain("Masked");
    // The raw CUIT never appears; only the frozen masked form does.
    expect(html).not.toContain("20417277529");
  });

  test("dismissed error hides until a newer proof supersedes it", () => {
    const fault: ToasterProof = { ...SEED, resultado: "R", cae: "" };
    const panel = buildToasterPanel([fault], { recorded: true, now: NOW });
    expect(renderToasterPanel(panel, new Set())).toContain("ARCA rejected this invoice");
    expect(renderToasterPanel(panel, new Set([panel.error!.proofId]))).not.toContain("ARCA rejected this invoice");
  });

  test("label bands carry IN/OUT/PROVED/CHANGED with masked sender", () => {
    const bands = labelBands(SEED);
    expect(bands.map((b) => b.title)).toEqual(["IN", "OUT", "PROVED", "CHANGED"]);
    const flat = bands.flatMap((b) => b.rows.map((r) => `${r.k}=${r.v}`)).join(" ");
    expect(flat).toContain("MASKED");
    expect(flat).toContain("86431019567246");
    expect(flat).not.toContain("20417277529");
  });

  test("proof detail shows the exact proving input and output", () => {
    const html = renderProofDetail(SEED);
    expect(html).toContain("Proving input");
    expect(html).toContain("Proving output");
    expect(html).toContain("86431019567246");
    expect(html).toContain("toaster-gate-1:2026-10-23T15:03:23.326Z");
  });
});

describe("per-stage detail (each part clickable, each part distinct)", () => {
  test("ask and prove show different cards; gate tells the crossing", () => {
    const panel = buildToasterPanel([SEED], { recorded: true, now: NOW });
    const ask = renderStageDetail(panel, "ask");
    const prove = renderStageDetail(panel, "prove");
    const gate = renderStageDetail(panel, "gate");
    expect(ask).toContain("factura C");
    expect(ask).not.toContain("86431019567246");
    expect(prove).toContain("86431019567246");
    expect(prove).not.toBe(ask);
    expect(gate).toContain("nothing else");
    expect(gate).toContain("1 item crossed");
    expect(gate).not.toContain("20417277529");
  });
});

describe("glanceability (plain-words titles)", () => {
  test("stage titles name the job and its object, never a bare verb", () => {
    const panel = buildToasterPanel([SEED], { recorded: true, now: NOW });
    const titles = panel.stages.map((s) => s.title).join(" | ");
    expect(titles).toContain("invoice");
    expect(titles).toContain("ARCA");
    expect(titles).toContain("CAE");
    for (const s of panel.stages) expect(s.title.split(" ").length).toBeGreaterThan(2);
  });
});

describe("toaster-ticker", () => {
  test("factual entries carry their proof id; readout is the latest beat", () => {
    const entries = tickerEntries([SEED], NOW);
    expect(entries.map((e) => e.state)).toEqual(["proven", "proven"]);
    expect(entries.every((e) => e.proofId === "toaster-gate-1:2026-10-23T15:03:23.326Z")).toBe(true);
    expect(tickerReadout(entries)).toContain("86431019567246");
  });

  test("superseded entries are kept and marked STALE, never dropped", () => {
    const newer: ToasterProof = { ...SEED, ranAt: "2026-10-23T16:00:00.000Z", cae: "86431019567247" };
    const entries = tickerEntries([SEED, newer], NOW);
    expect(entries).toHaveLength(4);
    expect(entries.slice(0, 2).every((e) => e.stale)).toBe(true);
    expect(entries.slice(2).every((e) => !e.stale)).toBe(true);
    expect(renderTicker(entries)).toContain("STALE");
  });

  test("empty ticker invites the first invoice as trying, not fact", () => {
    const entries = tickerEntries([], NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe("trying");
    expect(entries[0]!.proofId).toBeUndefined();
  });
});

describe("toaster-airlock", () => {
  test("one plain sentence, one item crossed, secrets only as mask blocks", () => {
    const view = airlockFor(SEED);
    expect(view.sentence).toBe("Sending this invoice data to ARCA homologación, nothing else.");
    expect(view.itemsCrossed).toBe(1);
    const html = renderAirlock(view);
    expect(html).toContain("1 item crossed");
    expect(html).toContain("Masked");
    expect(html).not.toContain("20417277529");
  });

  test("no proof means zero crossed, honestly stated", () => {
    const view = airlockFor(undefined);
    expect(view.itemsCrossed).toBe(0);
    expect(view.sentence).toContain("Nothing has crossed yet");
  });
});
