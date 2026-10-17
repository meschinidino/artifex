/**
 * E2E harness tests: the browse wrapper and waitFor are the suite's
 * foundation — a regression here either hangs CI (the 15-minute wedge
 * that motivated the watchdog) or corrupts every probe read. All tests
 * run the wrapper against /bin/sh, so they stay hermetic and fast with
 * no browser daemon.
 */
import { afterAll, describe, expect, test } from "bun:test";

// Before any browseBin() call: every test below drives the wrapper
// against the shell instead of the browser driver. Restored after:
// test files share one bun process, and a leaked override would
// redirect the browser suite at /bin/sh (order-dependent failure).
const savedBin = process.env.ARTIFEX_BROWSE_BIN;
process.env.ARTIFEX_BROWSE_BIN = "/bin/sh";
afterAll(() => {
  if (savedBin === undefined) delete process.env.ARTIFEX_BROWSE_BIN;
  else process.env.ARTIFEX_BROWSE_BIN = savedBin;
});

import { browse, browseBin, waitFor } from "./browse.ts";

describe("browseBin", () => {
  // Value: protects=env-override binary resolution (the CI path to
  // the pinned driver); fails_when=the override is ignored (CI runs
  // whatever driver happens to be installed); why_new=re-audit.
  test("ARTIFEX_BROWSE_BIN wins and caches", () => {
    expect(browseBin()).toBe("/bin/sh");
    expect(browseBin()).toBe("/bin/sh");
  });

  // Value: protects=cache invalidation on env change (test files
  // share one bun process; a stale cache served the browser driver
  // to the shell tests when the suite ran second);
  // fails_when=the key drops (order-dependent suite failure);
  // why_new=re-audit regression (e2e run failed this way).
  test("an env change mid-process recomputes the binary", () => {
    expect(browseBin()).toBe("/bin/sh");
    process.env.ARTIFEX_BROWSE_BIN = "/bin/echo";
    try {
      expect(browseBin()).toBe("/bin/echo");
    } finally {
      process.env.ARTIFEX_BROWSE_BIN = "/bin/sh";
    }
    expect(browseBin()).toBe("/bin/sh");
  });
});

describe("browse", () => {
  // Value: protects=single-newline stripping (full trim would corrupt
  // probe strings with meaningful edge whitespace, e.g. "@path ");
  // fails_when=the strip drops (JSON.parse still fine, but raw text
  // probes gain a newline) or over-trims;
  // why_new=re-audit (browse.ts:84-87 untested).
  test("strips exactly one trailing newline", async () => {
    expect(await browse(["-c", "printf 'hi\\n'"])).toBe("hi");
    expect(await browse(["-c", "printf 'a\\n\\n'"])).toBe("a\n");
    expect(await browse(["-c", "printf 'x'"])).toBe("x");
  });

  // Value: protects=non-zero error context (stderr attached, command
  // named); fails_when=the error drops stderr (failures become
  // undebuggable "(no output)"); why_new=re-audit (browse.ts:81-83).
  test("non-zero exits throw with stderr context", async () => {
    let error: unknown;
    try {
      await browse(["-c", "echo oops >&2; exit 3"]);
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("exited 3: oops");
  });

  // Value: protects=the watchdog that SIGKILLs a wedged daemon call
  // (the 15-minute suite hang; Bun.spawn's own timeout was observed
  // to let `sleep 60` run 32s); fails_when=the race drops (a wedged
  // daemon stalls the suite until the runner gives up);
  // why_new=re-audit (browse.ts:70-80 untested).
  test("a runaway command is killed at the timeout", async () => {
    const start = Date.now();
    let error: unknown;
    try {
      await browse(["-c", "sleep 60"], 300);
    } catch (err) {
      error = err;
    }
    expect(String(error)).toMatch(/timed out after 300ms.*daemon wedged/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("waitFor", () => {
  // Value: protects=the suite's only sync primitive (no fixed
  // sleeps); fails_when=polling stops early (flakes) or never
  // returns the passing value; why_new=re-audit (browse.ts:121-137).
  test("resolves with the first passing value", async () => {
    let calls = 0;
    const v = await waitFor(
      () => ++calls,
      (n) => n >= 3,
      { intervalMs: 5, label: "counter" },
    );
    expect(v).toBe(3);
    expect(calls).toBe(3);
  });

  // Value: protects=honest timeout errors naming the wait;
  // fails_when=the label drops (timeouts become undebuggable) or the
  // wait never ends; why_new=re-audit (browse.ts:132-134).
  test("times out with the label attached", async () => {
    let error: unknown;
    try {
      await waitFor(async () => "still-blank", () => false, { timeoutMs: 200, intervalMs: 20, label: "never-ready" });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toBe("Error: waitFor timeout after 200ms: never-ready");
  });
});
