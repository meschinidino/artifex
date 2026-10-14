/**
 * Main-thread parser client (T3a worker thread, T3b subprocess per
 * batch): each batch spawns a short-lived `parse-run.ts` process
 * that parses, extracts imports, prints results, and exits — the
 * exit returns every byte of WASM-side memory to the OS. A stuck
 * batch is killed after PARSER_TIMEOUT_MS (watchdog precursor).
 *
 * Batch input never sits in the shared temp dir under a guessable
 * name: each client owns a private 0700 mkdtemp directory, so a
 * local user can neither pre-plant a symlink nor read another
 * user's batch contents (which include raw file text).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  MAX_PARSE_BYTES,
  decodeParseResponse,
  languageForPath,
  type ParseResult,
} from "./protocol.ts";

export { MAX_PARSE_BYTES, languageForPath, type ParseResult };

const BATCH_SIZE = 64;
const PARSER_TIMEOUT_MS = 60_000;

export type ParserClient = {
  /** Parse files; unsupported/oversized files need no round trip. */
  parse(files: { path: string; content: string }[]): Promise<ParseResult[]>;
  terminate(): void;
};

const unavailable = (path: string): ParseResult => ({
  path,
  ok: false,
  parsed: false,
  imports: [],
  error: "parser unavailable",
});

const runnerPath = Bun.fileURLToPath(new URL("./parse-run.ts", import.meta.url));

/** Drain a pipe to EOF, keeping only the first cap bytes. Never blocks the child. */
async function drainCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (kept < cap) {
        chunks.push(value);
        kept += value.length;
      }
    }
  } catch {
    /* killed mid-drain */
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks).subarray(0, cap);
  return new TextDecoder().decode(bytes);
}

export function createParserClient(): ParserClient {
  let nextId = 1;
  let closed = false;
  const inFlight = new Set<Subprocess>();
  // Lazily created inside parseBatch's try, so a temp-dir failure
  // yields unavailable results instead of throwing out of boot.
  let batchDir: string | undefined;

  async function parseBatch(files: { path: string; content: string }[]): Promise<ParseResult[]> {
    if (closed) return [];
    const id = nextId++;
    let proc: Subprocess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inputPath = "";
    try {
      batchDir ??= mkdtempSync(join(tmpdir(), "artifex-parse-"));
      inputPath = join(batchDir, `${id}.json`);
      await Bun.write(inputPath, JSON.stringify({ id, files }));
      // terminate() may have run during the write above (its rmSync
      // raced this one): the write recreates the directory via parent
      // creation, so remove it again instead of leaking it.
      if (closed) {
        try {
          rmSync(batchDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        batchDir = undefined;
        return files.map((f) => unavailable(f.path));
      }
      proc = Bun.spawn([process.execPath, runnerPath, inputPath], { stdout: "pipe", stderr: "pipe" });
      inFlight.add(proc);
      const stdout = proc.stdout;
      if (typeof stdout === "number" || !stdout) return files.map((f) => unavailable(f.path));
      // stderr drains concurrently (bounded): a chatty or crashing
      // child must never wedge the batch on a full pipe buffer.
      const stderr = proc.stderr;
      const errDrain =
        typeof stderr === "number" || !stderr ? Promise.resolve("") : drainCapped(stderr, 2048);
      const settled = await Promise.race([
        (async () => ({ text: await new Response(stdout).text(), code: await proc!.exited }))(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            try {
              proc!.kill();
            } catch {
              /* already gone */
            }
            resolve("timeout");
          }, PARSER_TIMEOUT_MS);
        }),
      ]);
      if (closed) return [];
      if (settled === "timeout") return files.map((f) => unavailable(f.path));
      if (settled.code !== 0) {
        console.error(`warn: parser batch failed (exit ${settled.code}): ${(await errDrain).slice(0, 200)}`);
        return files.map((f) => unavailable(f.path));
      }
      let decoded;
      try {
        decoded = decodeParseResponse(JSON.parse(settled.text));
      } catch {
        return files.map((f) => unavailable(f.path));
      }
      if (!decoded || decoded.id !== id) return files.map((f) => unavailable(f.path));
      return decoded.results;
    } catch {
      return files.map((f) => unavailable(f.path));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (proc) inFlight.delete(proc);
      if (inputPath !== "") {
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(inputPath);
        } catch {
          /* already gone */
        }
      }
    }
  }

  return {
    async parse(files) {
      // Results align with input order: one entry per input file.
      const results: ParseResult[] = new Array(files.length);
      const toParse: { index: number; path: string; content: string }[] = [];
      files.forEach((file, index) => {
        if (!languageForPath(file.path)) {
          results[index] = { path: file.path, ok: true, parsed: false, imports: [] };
        } else {
          toParse.push({ index, path: file.path, content: file.content });
        }
      });
      for (let i = 0; i < toParse.length; i += BATCH_SIZE) {
        const slice = toParse.slice(i, i + BATCH_SIZE);
        const batch = await parseBatch(slice.map(({ path, content }) => ({ path, content })));
        const byPath = new Map(batch.map((r) => [r.path, r]));
        slice.forEach((entry, j) => {
          // A failed batch resolves per-file unavailable: every
          // input still gets a defined result, never a hole in
          // the ParseResult[] the type promises.
          results[entry.index] =
            batch[j]?.path === entry.path ? batch[j]! : byPath.get(entry.path) ?? unavailable(entry.path);
        });
      }
      return results;
    },
    terminate() {
      // Terminal: in-flight batches resolve unavailable, and work
      // queued after stop() never spawns again.
      closed = true;
      for (const proc of inFlight) {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }
      inFlight.clear();
      if (batchDir !== undefined) {
        try {
          rmSync(batchDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        batchDir = undefined;
      }
    },
  };
}
