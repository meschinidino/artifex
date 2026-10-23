/**
 * Toaster credential loader (T4/R4): ARCA homologación cert + key
 * from 0600 files outside the repo (default `~/.arca-homo/`,
 * `ARCA_HOMO_DIR` overrides), same shape as the T5 agent token.
 * Values are never logged or returned in errors; the only display
 * form is `credsSummary`, which carries counts, never material.
 *
 * Also home to the pre-publish scan (T4): find key material in
 * repo files by pattern, reporting paths only — never the matched
 * content — so the check itself cannot leak what it hunts.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToasterCreds } from "../server/toaster-arca.ts";
import { maskCuit } from "../server/toaster-proof.ts";

export type LoadedCreds = {
  creds: ToasterCreds;
  /** Display-safe summary: masked CUIT + byte counts, no material. */
  summary: string;
};

/** Cert/key dir: env override, else `~/.arca-homo`. */
export function credsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARCA_HOMO_DIR ?? join(homedir(), ".arca-homo");
}

function readPem(dir: string, name: string, kind: "CERTIFICATE" | "PRIVATE KEY"): string {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`toaster-creds: missing ${name} in creds dir`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    // Not a refusal (dropped as gold-plating in review); a loud
    // warning in the error keeps lax perms visible, never silent.
    throw new Error(`toaster-creds: ${name} is readable by others (mode ${mode.toString(8)}); chmod 600 it first`);
  }
  const text = readFileSync(path, "utf8");
  if (!text.includes(`-----BEGIN ${kind}-----`) || !text.includes(`-----END ${kind}-----`)) {
    throw new Error(`toaster-creds: ${name} is not a PEM ${kind.toLowerCase()}`);
  }
  return text;
}

/** Load + validate homo creds. Fails closed; errors name no values. */
export function loadToasterCreds(cuit: number, dir = credsDir()): LoadedCreds {
  if (!Number.isInteger(cuit) || cuit <= 0) throw new Error("toaster-creds: CUIT must be a positive integer");
  const cert = readPem(dir, "arca-homo.crt", "CERTIFICATE");
  const key = readPem(dir, "arca-homo.key", "PRIVATE KEY");
  return {
    creds: { cuit, cert, key },
    summary: `CUIT ${maskCuit(cuit)} · cert ${cert.length}B · key ${key.length}B · homologación only`,
  };
}

export type KeyMaterialHit = { path: string; kind: "private-key" | "certificate" };

// Patterns assembled so this file never literally contains what
// it hunts (the scan would flag its own source once tracked).
const KEY_MATERIAL: { kind: KeyMaterialHit["kind"]; re: RegExp }[] = [
  { kind: "private-key", re: new RegExp("-{5}BEGIN (?:RSA |EC )?PRIVATE KEY-{5}") },
  { kind: "certificate", re: new RegExp("-{5}BEGIN CERTIFICATE-{5}") },
];

/**
 * Scan file contents for key material. Returns paths + kinds only:
 * the matched bytes never leave this function, so callers can
 * print the result verbatim in logs and CI.
 */
export function scanForKeyMaterial(files: readonly { path: string; content: string }[]): KeyMaterialHit[] {
  const hits: KeyMaterialHit[] = [];
  for (const f of files) {
    for (const { kind, re } of KEY_MATERIAL) {
      if (re.test(f.content)) hits.push({ path: f.path, kind });
    }
  }
  return hits;
}
