/**
 * Server entrypoint tests: `bun run start` is the shipping path, and
 * until the re-audit no test executed import.meta.main at all. Both
 * tests spawn the real CLI (precedent: spike/harness/cli-errors).
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-main-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  return dir;
}

/** Read stdout until the line matches or the process exits. */
function waitForLine(proc: { stdout: NodeJS.ReadableStream | null }, re: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}; got: ${buf.slice(0, 300)}`)), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buf += String(chunk);
      const line = buf.split("\n").find((l) => re.test(l));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line);
      }
    };
    proc.stdout?.on("data", onData);
  });
}

describe("server main", () => {
  // Value: protects=`bun run start` booting to a serving URL and
  // shutting down cleanly on SIGTERM; fails_when=flag parsing, boot,
  // or the shutdown hook breaks (the exact path every user runs);
  // why_new=re-audit (index.ts:1224-1240 untested).
  test("boots, prints its URL, and exits 0 on SIGTERM", async () => {
    const repo = fixtureRepo();
    try {
      const proc = spawn("bun", ["run", "server/index.ts", "--repo", repo, "--port", "0"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const line = await waitForLine(proc, /artifex floor for .* at http:\/\/.*\(\d+ buildings?\)/, 30_000);
        expect(line).toContain(repo);
        const url = line.match(/at (http:\/\/\S+)/)?.[1];
        expect(url).toBeDefined();
        expect((await fetch(url!)).status).toBe(200);
        proc.kill("SIGTERM");
        const code = await new Promise((resolveExit) => proc.on("exit", resolveExit));
        expect(code).toBe(0);
      } finally {
        proc.kill("SIGKILL");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=one-line CLI failure for a bad repo (same
  // friendly-error discipline as the spike CLIs); fails_when=the
  // catch drops (a stack trace or a hang instead of `error: ...`);
  // why_new=re-audit (index.ts:1242-1244 untested).
  test("a missing repo fails on one error line with exit 1", async () => {
    const proc = spawn("bun", ["run", "server/index.ts", "--repo", join(tmpdir(), "artifex-main-missing-qa"), "--port", "0"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise((resolveExit) => proc.on("exit", resolveExit));
    expect(code).toBe(1);
    expect(stderr.trim()).toMatch(/^error: /);
    expect(stderr).toContain("not a directory");
    expect(stderr).not.toMatch(/\n\s+at\s/);
  }, 60_000);
});
