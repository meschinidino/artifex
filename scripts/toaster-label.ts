#!/usr/bin/env bun
/**
 * Toaster label export (T6): render the standalone nutrition
 * label for one proof record (default: the archived gate seed).
 *
 * Run: bun run scripts/toaster-label.ts [proof.json] [out.html]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToasterLabel } from "../server/toaster-label.ts";
import { TOASTER_PROOF_SCHEMA, type ToasterProof } from "../server/toaster-proof.ts";

const proofPath = process.argv[2] ?? join(import.meta.dir, "..", "e2e", "toaster-gate.live.json");
const outPath = process.argv[3] ?? join(import.meta.dir, "..", "toaster-label.html");
const proof = JSON.parse(readFileSync(proofPath, "utf8")) as ToasterProof;
if (proof.schema !== TOASTER_PROOF_SCHEMA) {
  console.error(`FAIL: ${proofPath} is not a ${TOASTER_PROOF_SCHEMA} record`);
  process.exit(1);
}
writeFileSync(outPath, renderToasterLabel(proof));
console.log(`label written: ${outPath} (CAE ${proof.cae || "—"}, ${proof.stub ? "simulated" : "recorded"})`);
