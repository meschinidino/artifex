import { describe, expect, test } from "bun:test";
import { createStubArca } from "./toaster-arca.ts";
import {
  buildTestVoucher,
  FACTURA_C,
  maskCuit,
  runGateProof,
  TOASTER_PROOF_SCHEMA,
} from "./toaster-proof.ts";

const INV = { ptoVta: 1, impTotal: 1000 };

describe("toaster-proof", () => {
  test("proof key set is frozen", async () => {
    const proof = await runGateProof(createStubArca(), 20111111112, INV);
    expect(Object.keys(proof).sort()).toEqual(
      [
        "cae",
        "caeFchVto",
        "cuitMasked",
        "env",
        "errors",
        "latencyMs",
        "obs",
        "ranAt",
        "reproceso",
        "resultado",
        "schema",
        "stub",
        "voucher",
      ].sort(),
    );
    expect(Object.keys(proof.voucher).sort()).toEqual(
      ["cbteDesde", "cbteHasta", "cbteTipo", "impTotal", "monId", "ptoVta"].sort(),
    );
    expect(Object.keys(proof.latencyMs).sort()).toEqual(["status", "voucher"]);
  });

  test("stub proof is honestly flagged and well-shaped", async () => {
    const proof = await runGateProof(createStubArca(), 20111111112, INV);
    expect(proof.schema).toBe(TOASTER_PROOF_SCHEMA);
    expect(proof.env).toBe("homologacion");
    expect(proof.stub).toBe(true);
    expect(proof.cuitMasked).toBe("20•••••••2");
    expect(proof.voucher.cbteTipo).toBe(FACTURA_C);
    expect(proof.voucher.monId).toBe("PES");
    expect(proof.cae).toHaveLength(14);
    expect(Array.isArray(proof.obs)).toBe(true);
    expect(Array.isArray(proof.errors)).toBe(true);
  });

  test("voucher mapping carries the homo-test defaults", () => {
    const v = buildTestVoucher(INV);
    expect(v.CbteTipo).toBe(11);
    expect(v.Concepto).toBe(1);
    expect(v.DocTipo).toBe(99);
    expect(v.DocNro).toBe(0);
    expect(v.CondicionIVAReceptorId).toBe(5);
    expect(v.MonId).toBe("PES");
    expect(v.MonCotiz).toBe(1);
    expect(v.CantReg).toBe(1);
    expect(v.CbteFch).toMatch(/^\d{8}$/);
    expect(v.ImpTotal).toBe(1000);
    expect(v.ImpNeto).toBe(1000);
  });

  test("voucher mapping honors overrides", () => {
    const v = buildTestVoucher({
      ...INV,
      concepto: 2,
      fchServDesde: "20240101",
      fchServHasta: "20240131",
      fchVtoPago: "20240215",
    });
    expect(v.Concepto).toBe(2);
    expect(v.FchServDesde).toBe("20240101");
    expect(v.FchServHasta).toBe("20240131");
    expect(v.FchVtoPago).toBe("20240215");
  });

  test("cuit mask keeps first-2/last-1, masks malformed fully", () => {
    expect(maskCuit(20111111112)).toBe("20•••••••2");
    expect(maskCuit(123)).toBe("[masked]");
  });

  test("live proof without a client fails closed", async () => {
    await expect(
      runGateProof({ kind: "live", status: async () => ({}) } as never, 20111111112, INV),
    ).rejects.toThrow("needs a client");
  });
});
