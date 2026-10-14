import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExcluded, listFiles } from "./scan.ts";
import { countLines, decodeUtf8Prefix, isBinaryBuffer, isEnvFile, maskContent } from "./mask.ts";
import { diffListing, type FileMeta } from "./index.ts";
import { isRepoRelativePath, resolveInsideRepo } from "../server/paths.ts";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-fixture-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "b.py"), "x = 1\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, "dist", "bundle.js"), "console.log(1);\n");
  return dir;
}

describe("scan", () => {
  test("walk listing excludes hard-excluded dirs; git listing agrees", () => {
    const dir = fixtureRepo();
    try {
      expect(listFiles(dir)).toEqual(["README.md", "src/a.ts", "src/b.py"]);
      const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      expect(init.exitCode).toBe(0);
      // dist/ is untracked and not gitignored, so git lists it and the
      // hard exclude must still drop it.
      expect(listFiles(dir)).toEqual(["README.md", "src/a.ts", "src/b.py"]);
      expect(isExcluded("a/node_modules/b.js")).toBe(true);
      expect(isExcluded("src/.artifex/x")).toBe(true);
      expect(isExcluded("src/ok.ts")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mask", () => {
  test("env detection is fail-closed across env-file conventions", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("config/.env.local")).toBe(true);
    expect(isEnvFile("config/prod.env")).toBe(true);
    expect(isEnvFile("src/.envrc")).toBe(true);
    expect(isEnvFile(".ENV")).toBe(true);
    expect(isEnvFile("env.ts")).toBe(false);
  });

  test("secret assignments are masked with the fixed token", () => {
    const input = [
      "const API_TOKEN = 'abc123';",
      "export MY_SECRET_KEY=hunter2",
      "password: correct-horse",
      "const monkey = 1;",
      "const name = 'value';",
    ].join("\n");
    const { content, masked } = maskContent(input);
    expect(masked).toBe(true);
    expect(content).not.toContain("abc123");
    expect(content).not.toContain("hunter2");
    expect(content).not.toContain("correct-horse");
    // Substring rule over-masks "monkey" (contains KEY): the safe error.
    expect(content).toContain("const name = 'value';");
    expect(content.match(/\[masked\]/g)?.length).toBe(4);
  });

  test("CRLF secret assignments are masked too (Claude review regression)", () => {
    const { content, masked } = maskContent("API_KEY=abc\r\nTOKEN: xyz\r\nok=1\r\n");
    expect(masked).toBe(true);
    expect(content).not.toContain("abc");
    expect(content).not.toContain("xyz");
    expect(content).toContain("[masked]\r\n");
    expect(content).toContain("ok=1\r\n");
  });

  test("a wrapped quoted secret value on the next line is masked", () => {
    const { content, masked } = maskContent('const API_KEY =\n  "sk-live-123";\nconst other = "visible";\n');
    expect(masked).toBe(true);
    expect(content).not.toContain("sk-live-123");
    expect(content).toContain('"visible"');
  });

  test("a long keyword-shaped line with no delimiter does not backtrack", () => {
    const start = performance.now();
    const { masked } = maskContent("key".repeat(20_000));
    expect(masked).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("UTF-8 prefix decode drops only a character cut by the cap", () => {
    const cut = new TextEncoder().encode("€".repeat(10)).subarray(0, 29);
    expect(isBinaryBuffer(cut)).toBe(true); // as a whole buffer it is invalid
    expect(decodeUtf8Prefix(cut)).toBe("€".repeat(9));
    expect(decodeUtf8Prefix(new Uint8Array([0x41, 0x00, 0x42]))).toBeUndefined();
    expect(decodeUtf8Prefix(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
  });

  test("binary detection and line counting", () => {
    expect(isBinaryBuffer(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
    expect(isBinaryBuffer(new TextEncoder().encode("hola\n"))).toBe(false);
    expect(isBinaryBuffer(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(true);
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });
});

describe("paths", () => {
  test("shape rejects absolute, traversal, backslash, dot segments", () => {
    expect(isRepoRelativePath("src/a.ts")).toBe(true);
    expect(isRepoRelativePath("/etc/passwd")).toBe(false);
    expect(isRepoRelativePath("../secret")).toBe(false);
    expect(isRepoRelativePath("src/../secret")).toBe(false);
    expect(isRepoRelativePath("src\\a.ts")).toBe(false);
    expect(isRepoRelativePath("")).toBe(false);
    expect(isRepoRelativePath(42)).toBe(false);
  });

  test("symlink escape is rejected; real file resolves", () => {
    const dir = fixtureRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "shh\n");
      symlinkSync(join(outside, "secret.txt"), join(dir, "src", "link.txt"));
      expect(listFiles(dir)).not.toContain("src/link.txt");
      expect(resolveInsideRepo(dir, "src/link.txt")).toEqual({ ok: false, code: "bad-path" });
      const good = resolveInsideRepo(dir, "src/a.ts");
      expect(good.ok).toBe(true);
      expect(resolveInsideRepo(dir, "src/missing.ts")).toEqual({ ok: false, code: "not-found" });
      expect(resolveInsideRepo(dir, "../x")).toEqual({ ok: false, code: "bad-path" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("diffListing", () => {
  const meta = (ino: number, size = 10, mtimeMs = 1): FileMeta => ({ dev: 1, ino, size, mtimeMs });

  test("inode-only replacement counts as modified (review regression)", () => {
    const known = new Map([["a.ts", meta(1)]]);
    const current = new Map([["a.ts", meta(2)]]); // same size + mtime, new inode
    expect(diffListing(known, current)).toEqual([{ kind: "modified", path: "a.ts" }]);
  });

  test("reused inode with different size/mtime is create+delete, not a rename", () => {
    const known = new Map([["old.ts", meta(7, 10, 1)]]);
    const current = new Map([["new.ts", meta(7, 999, 2)]]);
    const changes = diffListing(known, current);
    expect(changes).toContainEqual({ kind: "created", path: "new.ts" });
    expect(changes).toContainEqual({ kind: "deleted", path: "old.ts" });
    expect(changes.some((c) => c.kind === "renamed")).toBe(false);
  });

  test("create/modify/delete and inode rename pairing", () => {
    const known = new Map([
      ["a.ts", meta(1)],
      ["b.ts", meta(2)],
      ["gone.ts", meta(3)],
    ]);
    const current = new Map([
      ["a.ts", meta(1, 99)], // modified (size)
      ["b-renamed.ts", meta(2)], // same inode as b.ts
      ["new.ts", meta(9)],
    ]);
    const changes = diffListing(known, current);
    expect(changes).toContainEqual({ kind: "modified", path: "a.ts" });
    expect(changes).toContainEqual({ kind: "renamed", path: "b-renamed.ts", fromPath: "b.ts" });
    expect(changes).toContainEqual({ kind: "created", path: "new.ts" });
    expect(changes).toContainEqual({ kind: "deleted", path: "gone.ts" });
    expect(changes).not.toContainEqual({ kind: "deleted", path: "b.ts" });
    expect(changes.length).toBe(4);
  });
});
