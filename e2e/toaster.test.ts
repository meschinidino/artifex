/**
 * Toaster gate E2E (T2): the real WSAA login + WSFE send against ARCA
 * homologación, asserting a test CAE comes back aprobado.
 *
 * Double-gated: ARTIFEX_E2E=1 (`bun run e2e`) AND homo creds on disk
 * (~/.arca-homo/arca-homo.crt + .key, 0600, outside the repo) AND
 * ARCA_HOMO_CUIT in env. CI has none of these, so this skips there by
 * design; the gate runs on the builder's box. Each run mints one real
 * homo test invoice (auto-numbered, ptoVta 1, factura C, $1000).
 *
 * Set ARTIFEX_PROOF_OUT=<path> to also save the proof record (T8 seed).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLiveGateProof } from "../server/toaster-proof.ts";

const CRT = join(process.env.HOME ?? "", ".arca-homo", "arca-homo.crt");
const KEY = join(process.env.HOME ?? "", ".arca-homo", "arca-homo.key");
const CUIT = Number(process.env.ARCA_HOMO_CUIT ?? "0");
const LIVE = Boolean(process.env.ARTIFEX_E2E) && existsSync(CRT) && existsSync(KEY) && CUIT > 0;

describe.skipIf(!LIVE)("toaster gate e2e", () => {
  test(
    "homologación returns a test CAE, aprobado",
    async () => {
      const proof = await runLiveGateProof(
        {
          cuit: CUIT,
          cert: readFileSync(CRT, "utf8"),
          key: readFileSync(KEY, "utf8"),
        },
        { ptoVta: 1, impTotal: 1000 },
      );
      expect(proof.schema).toBe("toaster-gate-1");
      expect(proof.env).toBe("homologacion");
      expect(proof.stub).toBe(false);
      expect(proof.resultado).toBe("A");
      expect(proof.cae).toMatch(/^\d{14}$/);
      expect(proof.caeFchVto).toMatch(/^\d{8}$/);
      expect(proof.errors).toEqual([]);
      expect(proof.voucher.cbteDesde).toBeGreaterThan(0);
      const out = process.env.ARTIFEX_PROOF_OUT;
      if (out) writeFileSync(out, `${JSON.stringify(proof, null, 2)}\n`);
    },
    { timeout: 90000 },
  );
});
