#!/usr/bin/env bun
/**
 * Toaster film harness (T8/R8): boot the floor with the archived
 * gate proof as a labeled replay, so film day never depends on
 * ARCA's test environment being up. The on-screen RECORDED PROOF
 * banner is the honesty contract — this harness never presents
 * the replay as live.
 *
 * Run: bun run scripts/toaster-film.ts [--repo <path>] [--port <n>]
 * Scene override (failure scenes): ARTIFEX_TOASTER_PROOF=<proof.json>
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFloorServer } from "../server/index.ts";
import { TOASTER_PROOF_SCHEMA, type ToasterProof } from "../server/toaster-proof.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = resolve(flag("--repo") ?? join(import.meta.dir, ".."));
const port = Number(flag("--port") ?? "4521");

const proofPath = process.env.ARTIFEX_TOASTER_PROOF
  ?? join(import.meta.dir, "..", "e2e", "toaster-gate.live.json");
if (!existsSync(proofPath)) {
  console.error(`FAIL: no proof record at ${proofPath} — run the gate first (docs/arca-homologacion.md).`);
  process.exit(1);
}
const proof = JSON.parse(readFileSync(proofPath, "utf8")) as ToasterProof;
if (proof.schema !== TOASTER_PROOF_SCHEMA) {
  console.error(`FAIL: ${proofPath} is not a ${TOASTER_PROOF_SCHEMA} record.`);
  process.exit(1);
}

const server = await createFloorServer({ repo, port, agent: false });
console.log(`film floor: ${server.url} (repo ${repo})`);
console.log(`scene: recorded proof ${proof.ranAt} · CAE ${proof.cae || "—"} · resultado ${proof.resultado || "—"} · banner will read RECORDED PROOF · NOT LIVE`);
console.log("film checklist: bay visible on load · click PROVE for proving input/output · label via scripts/toaster-label.ts");
