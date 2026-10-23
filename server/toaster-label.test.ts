import { describe, expect, test } from "bun:test";
import type { ToasterProof } from "./toaster-proof.ts";
import { renderToasterLabel } from "./toaster-label.ts";

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

describe("toaster-label (T6)", () => {
  test("standalone card: four bands, real CAE, honesty line, no raw CUIT, no external refs", () => {
    const html = renderToasterLabel(SEED);
    for (const band of ["IN", "OUT", "PROVED", "CHANGED"]) expect(html).toContain(`>${band}<`);
    expect(html).toContain("86431019567246");
    expect(html).toContain("not a live filing");
    expect(html).toContain("20•••••••9");
    expect(html).not.toContain("20417277529");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script");
  });

  test("stub label says simulated, never proven-live", () => {
    const html = renderToasterLabel({ ...SEED, stub: true });
    expect(html).toContain("Simulated proof");
    expect(html).not.toContain("not a live filing");
  });
});
