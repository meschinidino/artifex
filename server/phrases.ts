/**
 * Belt purpose phrases (PPH2/PPH5): one batched agent call per
 * floor maps every import belt to an ultra-short verb phrase.
 * Pure prompt assembly + strict parsing; the runner shares
 * summarize.ts's spawn seam with its own stub env for e2e.
 */
import { runAgentText, SummaryError, type RunSpawn } from "./summarize.ts";

/** Words per phrase (canvas plates stay readable). */
export const PHRASE_WORD_CAP = 6;
/** Batch timeout: hundreds of belts in one call. */
export const PHRASES_TIMEOUT_MS = 300_000;
/** Cached phrase maps per floor (one entry per belt-set). */
export const PHRASES_CACHE_SIZE = 5;
/** Cited lines per belt (evidence grounding). */
export const PHRASES_CITES_EACH = 2;
/** Chars per cited line. */
export const PHRASE_CITE_CHARS = 160;

/**
 * Test-file detection (PPH4): test basenames (`test_*`,
 * `*.test.*`, `*_test.*`) and test dirs (`tests/`, `__tests__/`).
 */
export function isTestPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^test_.*|.*\.test\..*|.*_test\..*/.test(base)) return true;
  return /(^|\/)(tests?|__tests__)\//.test(path);
}

export type PhraseBeltInput = {
  from: string;
  to: string;
  fromTest: boolean;
  toTest: boolean;
  /** Carried symbol names (may be empty: symbols unlisted). */
  symbols: string[];
  /** Unfolded symbol total (the `+n` tail). */
  total: number;
  /** Cited evidence lines (pre-capped by the caller). */
  cites: string[];
};

/** One batched prompt: numbered belts in, `{"n": "phrase"}` out. */
export function buildPhrasesPrompt(belts: PhraseBeltInput[]): string {
  const head = [
    "You write ultra-short purpose phrases for connections between files.",
    "",
    "RULES:",
    "- Reply with ONLY a JSON object mapping entry numbers to phrases (no other text, no code fences):",
    '  {"1": "fetches orders", "2": "styles tables"}',
    "- Each phrase: verb-led, at most 6 words, plain everyday words a smart non-programmer understands.",
    "- Say what the FIRST file gets from (or does with) the SECOND file.",
    "- A file marked TEST FILE only CHECKS the other file: phrase as checks/covers, never as uses.",
    "- Use only the context below. Omit any entry you cannot phrase confidently (missing numbers are fine).",
    "- Do not use tools.",
    "",
    "ENTRIES:",
  ];
  const lines = belts.map((b, i) => {
    const from = `"${b.from}"${b.fromTest ? " (TEST FILE)" : ""}`;
    const to = `"${b.to}"${b.toTest ? " (TEST FILE)" : ""}`;
    const syms =
      b.symbols.length > 0
        ? `uses ${b.symbols.join(", ")}${b.total > b.symbols.length ? ` (+${b.total - b.symbols.length} more)` : ""}`
        : "symbols unlisted";
    const ev = b.cites.length > 0 ? `evidence: ${b.cites.join("; ")}` : "no cited lines";
    return `${i + 1}. FROM ${from} TO ${to}: ${syms}; ${ev}`;
  });
  return [...head, ...lines].join("\n");
}

/**
 * Strict phrase-map parser: numbered keys within range, short
 * non-empty string values. Unknown keys, over-long values, and
 * unusable answers yield nothing (missing = symbols fallback).
 * Tolerates fenced answers.
 */
export function parsePhrasesJson(raw: string, count: number): Map<number, string> {
  const out = new Map<number, string>();
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) text = (fence[1] ?? "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return out;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      return out;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!/^\d+$/.test(k)) continue;
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    if (typeof v !== "string") continue;
    const phrase = v.trim().replace(/\s+/g, " ");
    if (phrase.length === 0) continue;
    if (phrase.split(" ").length > PHRASE_WORD_CAP) continue;
    if (!out.has(n)) out.set(n, phrase);
  }
  return out;
}

/** Cached phrase batch: pair-keyed map + the belt hash it was built from. */
export type PhrasesValue = { map: Record<string, string>; generatedAt: string; beltHash: string };

export type RunPhrasesOpts = {
  prompt: string;
  workspace: string;
  /** Human label for errors (floor name + belt count). */
  label: string;
  /** Belt count: bounds the accepted entry numbers. */
  count: number;
  timeoutMs?: number;
  command?: string;
  spawn?: RunSpawn;
};

/**
 * One batched phrase run: raw JSON map (its own stub env for
 * e2e: ARTIFEX_PHRASES_STUB carries a JSON map, or "error").
 * Throws SummaryError when nothing usable comes back — partial
 * maps are fine (missing entries fall back to symbols).
 */
export async function runPhrases(opts: RunPhrasesOpts): Promise<Map<number, string>> {
  const stub = process.env.ARTIFEX_PHRASES_STUB;
  if (stub === "error") throw new SummaryError("stub failure");
  const raw =
    stub !== undefined
      ? stub
      : await runAgentText({
          prompt: opts.prompt,
          workspace: opts.workspace,
          label: opts.label,
          timeoutMs: opts.timeoutMs ?? PHRASES_TIMEOUT_MS,
          command: opts.command,
          spawn: opts.spawn,
        });
  const map = parsePhrasesJson(raw, opts.count);
  if (map.size === 0) throw new SummaryError("phraser returned no usable phrases");
  return map;
}
