/**
 * Typed wrapper over the gstack browse driver CLI for the E2E suite.
 *
 * Every call spawns the `browse` binary via argv (never a shell string),
 * so fill values and js expressions cannot interpolate. Non-zero exits
 * throw with the driver's stderr attached.
 *
 * Every call is bounded by a timeout (async spawn, natively killed):
 * the driver daemon has been observed to wedge (goto then never
 * returns), and an unbounded wait would stall the suite until the
 * runner gives up. Timeouts fail fast and honestly instead.
 *
 * Binary resolution: `ARTIFEX_BROWSE_BIN` wins (CI sets this to the pinned
 * gstack checkout's compiled CLI), then the known local install paths.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedBin: string | undefined;
let cachedEnv: string | undefined;

export function browseBin(): string {
  // The cache is keyed on the override: a mid-process env change
  // (tests sharing one bun process) recomputes instead of serving a
  // stale binary. Production never changes the env mid-run.
  const override = process.env.ARTIFEX_BROWSE_BIN;
  if (override !== cachedEnv) {
    cachedEnv = override;
    cachedBin = undefined;
  }
  if (cachedBin) return cachedBin;
  const candidates = [
    process.env.ARTIFEX_BROWSE_BIN,
    join(homedir(), ".gstack/repos/gstack/browse/dist/browse"),
    join(homedir(), ".codex/skills/gstack/browse/dist/browse"),
  ].filter((p): p is string => p !== undefined && p !== "");
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedBin = c;
      return c;
    }
  }
  throw new Error(
    `browse driver not found (tried ${candidates.join(", ") || "nothing"}); ` +
      `set ARTIFEX_BROWSE_BIN to the gstack browse binary`,
  );
}

/** Default bound for one driver call. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Navigation covers a cold daemon + chromium launch. */
const NAV_TIMEOUT_MS = 120_000;

/**
 * Run one driver command; throw on non-zero exit (with stderr context)
 * or on timeout (the daemon wedged — fail fast, say so).
 *
 * The timeout is a manual watchdog race, not Bun.spawn's `timeout`
 * option: observed on bun 1.3.14, `timeout: 2000` let `sleep 60` run
 * 32s before SIGTERM landed. The watchdog SIGKILLs and rejects, so a
 * wedged daemon call can never stall the suite past `timeoutMs`.
 */
export async function browse(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  const proc = Bun.spawn([browseBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (async () => {
    try {
      const [out, err, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { out, err, exitCode };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead; the run below reports the real outcome
      }
      reject(new Error(`browse ${args.join(" ")} timed out after ${timeoutMs}ms (daemon wedged?)`));
    }, timeoutMs);
  });
  const { out, err, exitCode } = await Promise.race([run, watchdog]);
  if (exitCode !== 0) {
    throw new Error(`browse ${args.join(" ")} exited ${exitCode}: ${err.trim() || out.trim() || "(no output)"}`);
  }
  // Strip one trailing newline only: full trim() would corrupt page
  // strings with meaningful edge whitespace (e.g. the "@path " dispatch
  // prefix). JSON.parse tolerates the absence of trimming.
  return out.replace(/\r?\n$/, "");
}

export const bGoto = (url: string): Promise<string> => browse(["goto", url], NAV_TIMEOUT_MS);
export const bClick = (sel: string): Promise<string> => browse(["click", sel]);
export const bFill = (sel: string, val: string): Promise<string> => browse(["fill", sel, val]);
export const bPress = (key: string): Promise<string> => browse(["press", key]);
export const bReload = (): Promise<string> => browse(["reload"], NAV_TIMEOUT_MS);
export const bNewtab = (url?: string): Promise<string> =>
  browse(url === undefined ? ["newtab"] : ["newtab", url], NAV_TIMEOUT_MS);
export const bClosetab = (id?: number): Promise<string> =>
  browse(id === undefined ? ["closetab"] : ["closetab", String(id)]);
export const bTabs = (): Promise<string> => browse(["tabs"]);

/**
 * Close every driver tab (stray manual tabs spew into the
 * daemon-wide console buffer and poison the per-test console
 * guard). The daemon keeps one blank tab; it is silent.
 */
export async function bCloseAllTabs(): Promise<void> {
  const listing = await bTabs();
  const ids = [...listing.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  for (const id of ids) {
    try {
      await bClosetab(id);
    } catch {
      // Tab already gone (a concurrent close won the race).
    }
  }
}
export const bViewport = (size: string): Promise<string> => browse(["viewport", size]);
export const bScreenshot = (path: string): Promise<string> => browse(["screenshot", path]);
export const bConsoleErrors = (): Promise<string> => browse(["console", "--errors"]);
export const bConsoleClear = (): Promise<string> => browse(["console", "--clear"]);

/**
 * Evaluate a page expression expected to produce an object, array,
 * number, or boolean (the driver prints those as JSON).
 */
export async function bJs<T>(expr: string): Promise<T> {
  return JSON.parse(await browse(["js", expr])) as T;
}

/**
 * Evaluate a page expression expected to produce a string (the driver
 * prints strings raw, unquoted — JSON.parse would corrupt them).
 */
export const bJsText = (expr: string): Promise<string> => browse(["js", expr]);

/**
 * Poll `fn` until `pred` passes. The only synchronization primitive in
 * the suite — no fixed sleeps anywhere. `fn` may be async (probe reads).
 */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label: string },
): Promise<T> {
  const timeout = opts.timeoutMs ?? 10000;
  const interval = opts.intervalMs ?? 150;
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timeout after ${timeout}ms: ${opts.label}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
