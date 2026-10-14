/**
 * Parser batch subprocess main (T3b, issue #3). Reads one JSON batch
 * { id, files: [{ path, content }] } from the file named by argv[2],
 * prints the encoded ParseResponse JSON to stdout, and exits. Exit
 * non-zero on any protocol failure; per-file failures are results,
 * not process failures.
 */
import { readFileSync } from "node:fs";
import { encodeParseResponse } from "./protocol.ts";
import { parseBatch } from "./extract.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: parse-run.ts <batch.json>");
  process.exit(2);
}

let input: unknown;
try {
  input = JSON.parse(readFileSync(inputPath, "utf8"));
} catch {
  console.error("batch is not valid JSON");
  process.exit(2);
}

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
if (
  !isRec(input) ||
  typeof input.id !== "number" ||
  !Number.isInteger(input.id) ||
  !Array.isArray(input.files) ||
  !input.files.every(
    (f): f is { path: string; content: string } =>
      isRec(f) && typeof f.path === "string" && typeof f.content === "string",
  )
) {
  console.error("batch has a bad shape");
  process.exit(2);
}

const results = await parseBatch(input.files);
process.stdout.write(JSON.stringify(encodeParseResponse(input.id, results)) + "\n");
