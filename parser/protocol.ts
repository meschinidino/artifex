/**
 * Parser Worker wire protocol (T3a, issue #2; imports[] added in T3b,
 * issue #3). Both sides validate through this codec so a malformed
 * message fails closed instead of corrupting floor state.
 */

export const PARSER_PROTOCOL_VERSION = 1;

/** Files larger than this are never sent to the parser. */
export const MAX_PARSE_BYTES = 1024 * 1024;

export type ParseRequest = {
  v: typeof PARSER_PROTOCOL_VERSION;
  id: number;
  type: "parse";
  files: { path: string; content: string }[];
};

/**
 * One raw literal import reference. TS/JS carries the literal
 * specifier string; Python carries the relative level (0 for
 * absolute), the dotted module suffix, and the imported names.
 * Only literal forms are ever emitted: template-string dynamic
 * imports, computed requires, and escaped specifiers are skipped
 * by the extractor (never guessed).
 */
export type ImportRef =
  | { lang: "ts"; specifier: string }
  | { lang: "py"; level: number; module: string; names: string[] };

export type ParseResult = {
  path: string;
  ok: boolean;
  /** False for languages without a loaded grammar. */
  parsed: boolean;
  /** Raw literal imports; empty for parse errors and unknown languages. */
  imports: ImportRef[];
  error?: string;
};

export type ParseResponse = {
  v: typeof PARSER_PROTOCOL_VERSION;
  id: number;
  results: ParseResult[];
};

/**
 * Map a parser result to the floor's parse state. A failed parse
 * (ok:false) is never "ok": parsed failures are errors, failures
 * before parsing (grammar/process unavailable) are unparsed so the
 * UI never claims a healthy parse it did not perform.
 */
export function parseStateForResult(result: ParseResult): "ok" | "error" | "unparsed" {
  if (result.ok) return "ok";
  return result.parsed ? "error" : "unparsed";
}

export type SupportedLanguage = "typescript" | "tsx" | "python";

export function languageForPath(path: string): SupportedLanguage | undefined {
  // The JS family uses the tsx grammar: .js files legally contain JSX
  // in React repos, and the typescript grammar would flag healthy
  // files as parse errors (red must mean a real error).
  if (/\.(tsx|jsx|js|mjs|cjs)$/.test(path)) return "tsx";
  if (/\.(ts|mts|cts)$/.test(path)) return "typescript";
  if (/\.py$/.test(path)) return "python";
  return undefined;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function encodeParseRequest(id: number, files: { path: string; content: string }[]): ParseRequest {
  return { v: PARSER_PROTOCOL_VERSION, id, type: "parse", files };
}

export function decodeParseRequest(input: unknown): ParseRequest | undefined {
  if (!isRecord(input)) return undefined;
  if (input.v !== PARSER_PROTOCOL_VERSION || input.type !== "parse") return undefined;
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) return undefined;
  if (!Array.isArray(input.files)) return undefined;
  for (const f of input.files) {
    if (!isRecord(f) || typeof f.path !== "string" || typeof f.content !== "string") {
      return undefined;
    }
  }
  return input as ParseRequest;
}

export function encodeParseResponse(id: number, results: ParseResult[]): ParseResponse {
  return { v: PARSER_PROTOCOL_VERSION, id, results };
}

function isImportRef(x: unknown): x is ImportRef {
  if (!isRecord(x)) return false;
  if (x.lang === "ts") {
    return typeof x.specifier === "string" && Object.keys(x).length === 2;
  }
  if (x.lang === "py") {
    return typeof x.level === "number" && Number.isSafeInteger(x.level) && (x.level as number) >= 0
      && typeof x.module === "string"
      && Array.isArray(x.names) && (x.names as unknown[]).every((n) => typeof n === "string")
      && Object.keys(x).length === 4;
  }
  return false;
}

export function decodeParseResponse(input: unknown): ParseResponse | undefined {
  if (!isRecord(input)) return undefined;
  if (input.v !== PARSER_PROTOCOL_VERSION) return undefined;
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) return undefined;
  if (!Array.isArray(input.results)) return undefined;
  for (const r of input.results) {
    if (!isRecord(r) || typeof r.path !== "string") return undefined;
    if (typeof r.ok !== "boolean" || typeof r.parsed !== "boolean") return undefined;
    if (!Array.isArray(r.imports) || !(r.imports as unknown[]).every(isImportRef)) return undefined;
    if (r.error !== undefined && typeof r.error !== "string") return undefined;
  }
  return input as ParseResponse;
}
