import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function expectFriendlyFailure(result: ReturnType<typeof run>, pattern: RegExp) {
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toMatch(/^error: /);
  expect(result.stderr).toMatch(pattern);
  expect(result.stderr).not.toMatch(/\n\s+at\s/);
}

describe("spike CLI errors (ISSUE-004)", () => {
  it("analyze reports a missing capture argument on one line", () => {
    expectFriendlyFailure(run(["run", "spike/harness/analyze.ts"]), /usage: analyze\.ts/);
  });

  it("run reports an unknown agent on one line", () => {
    expectFriendlyFailure(run(["run", "spike/harness/run.ts", "agente-inexistente"]), /unknown agent/);
  });

  it("parse-all reports a missing corpus with its generator command", () => {
    expectFriendlyFailure(
      run(["run", "spike/rss/parse-all.ts"], { ARTIFEX_CORPUS_DIR: "/tmp/artifex-corpus-missing-qa" }),
      /gen-corpus\.ts/,
    );
  });

  it("gen-corpus refuses to wipe a non-generated directory even under tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-gen-guard-"));
    try {
      writeFileSync(join(dir, "keep.txt"), "do not delete\n");
      expectFriendlyFailure(
        run(["run", "spike/rss/gen-corpus.ts", "--count", "10", "--folders", "2", "--out", dir]),
        /refusing to delete/,
      );
      expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gen-corpus refuses an existing file or symlinked output", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-gen-guard2-"));
    try {
      const file = join(dir, "notes.txt");
      writeFileSync(file, "keep\n");
      expectFriendlyFailure(run(["run", "spike/rss/gen-corpus.ts", "--out", file]), /refusing to delete/);
      expect(existsSync(file)).toBe(true);
      const empty = join(dir, "empty");
      mkdirSync(empty);
      const link = join(dir, "link-out");
      symlinkSync(empty, link);
      expectFriendlyFailure(run(["run", "spike/rss/gen-corpus.ts", "--out", link]), /refusing to delete/);
      expect(existsSync(empty)).toBe(true);
      const pkgOnly = join(dir, "pkgs");
      mkdirSync(join(pkgOnly, "pkg1"), { recursive: true });
      writeFileSync(join(pkgOnly, "pkg1", "keep.ts"), "export {};\n");
      expectFriendlyFailure(run(["run", "spike/rss/gen-corpus.ts", "--out", pkgOnly]), /refusing to delete/);
      expect(existsSync(join(pkgOnly, "pkg1", "keep.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gen-corpus rejects a present-but-empty flag value (review regression)", () => {
    expectFriendlyFailure(run(["run", "spike/rss/gen-corpus.ts", "--out", ""]), /--out needs a value/);
    expectFriendlyFailure(run(["run", "spike/rss/gen-corpus.ts", "--out"]), /--out needs a value/);
  });

  it("gen-corpus refusal names the missing marker (review regression)", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-gen-marker-"));
    try {
      mkdirSync(join(dir, "pkg1"), { recursive: true });
      const result = run(["run", "spike/rss/gen-corpus.ts", "--count", "10", "--folders", "2", "--out", dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no sibling marker found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
