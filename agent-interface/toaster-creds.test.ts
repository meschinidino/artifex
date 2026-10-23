import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToasterCreds, scanForKeyMaterial } from "./toaster-creds.ts";

// Headers built dynamically: literal PEM blocks never sit in
// tracked files (the T4 pre-publish scan hunts exactly them).
const pem = (kind: string, body: string) => `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----\n`;
const CERT = pem("CERTIFICATE", "ZmFrZWNlcnQ=");
const KEY = pem("PRIVATE KEY", "ZmFrZWtleQ==");

const dirs: string[] = [];
function credsFixture(certMode = 0o600, keyMode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-creds-"));
  dirs.push(dir);
  writeFileSync(join(dir, "arca-homo.crt"), CERT, { mode: certMode });
  writeFileSync(join(dir, "arca-homo.key"), KEY, { mode: keyMode });
  chmodSync(join(dir, "arca-homo.crt"), certMode);
  chmodSync(join(dir, "arca-homo.key"), keyMode);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("toaster-creds (T4)", () => {
  test("loads 0600 cert+key; summary masks the CUIT and counts bytes only", () => {
    const { creds, summary } = loadToasterCreds(20417277529, credsFixture());
    expect(creds.cert).toContain("CERTIFICATE");
    expect(creds.key).toContain("PRIVATE KEY");
    expect(summary).toContain("20•••••••9");
    expect(summary).not.toContain("20417277529");
    expect(summary).not.toContain("ZmFr");
  });

  test("missing files and bad CUIT fail closed, naming no values", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-creds-empty-"));
    dirs.push(dir);
    expect(() => loadToasterCreds(20417277529, dir)).toThrow("missing arca-homo.crt");
    expect(() => loadToasterCreds(0, credsFixture())).toThrow("CUIT");
  });

  test("world-readable key material is refused with the fix named", () => {
    expect(() => loadToasterCreds(20417277529, credsFixture(0o600, 0o644))).toThrow("chmod 600");
  });

  test("non-PEM content is refused", () => {
    const dir = credsFixture();
    writeFileSync(join(dir, "arca-homo.key"), "not a pem\n", { mode: 0o600 });
    chmodSync(join(dir, "arca-homo.key"), 0o600);
    expect(() => loadToasterCreds(20417277529, dir)).toThrow("not a PEM");
  });

  test("pre-publish scan reports paths + kinds only, never content", () => {
    const hits = scanForKeyMaterial([
      { path: "clean.ts", content: "const x = 1;" },
      { path: "leak.key", content: KEY },
      { path: "leak.crt", content: CERT },
    ]);
    expect(hits).toEqual([
      { path: "leak.key", kind: "private-key" },
      { path: "leak.crt", kind: "certificate" },
    ]);
    expect(JSON.stringify(hits)).not.toContain("ZmFr");
  });
});
