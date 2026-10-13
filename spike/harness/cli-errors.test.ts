import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

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
});
