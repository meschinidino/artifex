/**
 * AI summaries (SUM1-6): on-demand file + belt explanations via the
 * local `muse exec` CLI. Pure context assembly and prompts; the
 * runner is a thin unary spawn with timeout, cache, and a
 * deterministic stub seam for e2e (ARTIFEX_SUMMARY_STUB).
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** File content chars fed to the prompt. */
export const SUMMARY_CONTENT_CHARS = 8000;
/** In/out neighbors each for file context. */
export const SUMMARY_NEIGHBORS_EACH = 10;
/** Via lines per neighbor line. */
export const SUMMARY_VIA_EACH = 4;
/** Fan neighbors per endpoint for belt context. */
export const SUMMARY_FAN_EACH = 5;
/** Summary text chars kept for the UI. */
export const SUMMARY_TEXT_CHARS = 4000;
/** Per-endpoint content chars for belt context (evidence alone is too thin). */
export const SUMMARY_BELT_CONTENT_CHARS = 2000;
/** Runner timeout: summaries must stay interactive. */
export const SUMMARY_TIMEOUT_MS = 120_000;
/** In-memory cached summaries (oldest evicted). */
export const SUMMARY_CACHE_SIZE = 100;
/** Default reasoning effort for summary runs (a short explanation, not a task). */
export const SUMMARY_EFFORT_DEFAULT = "medium";
const SUMMARY_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/**
 * User-tunable effort (ARTIFEX_SUMMARY_EFFORT): read per request so
 * a server restart picks up a new value. Unknown values fall back
 * to the default rather than failing the run.
 */
export function summaryEffort(): string {
  const raw = (process.env.ARTIFEX_SUMMARY_EFFORT ?? "").trim().toLowerCase();
  return SUMMARY_EFFORTS.has(raw) ? raw : SUMMARY_EFFORT_DEFAULT;
}

export type SummaryNeighbor = { path: string; via: string[] };

export type FileSummaryInput = {
  path: string;
  zoneId: string;
  foot?: string;
  binary: boolean;
  /** Masked content (possibly pre-truncated by the caller: flag it). */
  content: string;
  contentTruncated: boolean;
  incoming: SummaryNeighbor[];
  outgoing: SummaryNeighbor[];
};

export type BeltEdgeSummary = { kind: string; via: string[] };

export type BeltSummaryInput = {
  fromPath: string;
  toPath: string;
  edges: BeltEdgeSummary[];
  /** Masked endpoint content (empty when unreadable: describe from evidence). */
  fromContent: string;
  toContent: string;
  fromFan: { inCount: number; outCount: number; neighbors: string[] };
  toFan: { inCount: number; outCount: number; neighbors: string[] };
};

const neighborLine = (n: SummaryNeighbor): string =>
  n.via.length > 0 ? `- ${n.path}: ${n.via.slice(0, SUMMARY_VIA_EACH).join("; ")}` : `- ${n.path}`;

const neighborBlock = (title: string, list: SummaryNeighbor[]): string => {
  const shown = list.slice(0, SUMMARY_NEIGHBORS_EACH).map(neighborLine);
  const rest = list.length - shown.length;
  if (rest > 0) shown.push(`(+${rest} more)`);
  return `${title}:\n${shown.length > 0 ? shown.join("\n") : "(none)"}`;
};

const PLAIN_RULES = [
  "Write plain everyday English for a smart adult who is not a programmer.",
  "Never use programmer words (import, export, dependency, fan-in, fan-out, parse,",
  "compile, binary, AST): if a technical term is unavoidable, explain it in plain",
  "words first. Name each file by its full path the first time, then by its",
  "short file name (the part after the last /). The quoted lines are evidence —",
  "describe what they show in words, never paste them.",
].join("\n");

const footNote = (foot: string | undefined): string =>
  !foot ? "" : foot.includes("NEW") ? ", a new file" : foot.includes("MODIFIED") ? ", a changed file" : "";

/** File prompt: fixed 3-line explanation a non-programmer can act on. */
export function buildFilePrompt(input: FileSummaryInput): string {
  const head = [
    "You explain ONE file.",
    PLAIN_RULES,
    "Do not use tools. Reply with ONLY this JSON object (no other text, no code fences):",
    '{"what": "<what the file does>", "why": "<what stops working without it>", "fits": "<which files use it, which files it uses>"}',
    "At most 40 words per value.",
    "Use only the context below. If something is unclear, say so plainly.",
    "",
    `FILE: ${input.path} (area ${input.zoneId} on the map${footNote(input.foot)})`,
  ].join("\n");
  const body = input.binary
    ? "CONTENT: (not readable as text — describe its likely role from the connections only)"
    : `CONTENT (first ${SUMMARY_CONTENT_CHARS} chars${input.contentTruncated ? ", truncated" : ""}):\n${input.content.slice(0, SUMMARY_CONTENT_CHARS)}`;
  return [head, body, neighborBlock("FILES THAT USE THIS FILE", input.incoming), neighborBlock("FILES THIS FILE USES", input.outgoing)].join(
    "\n\n",
  );
}

/** Plain-English rendering of the server's edge-kind labels. */
const edgeKindPlain = (kind: string): string =>
  kind === "HTTP CALL" ? "calls over the network" : kind === "KAFKA TOPIC" ? "sends messages through" : kind === "IMPORT" ? "takes code from" : kind;

/** Belt prompt: what flows between the files, and what breaks without it. */
export function buildBeltPrompt(input: BeltSummaryInput): string {
  const fan = (label: string, fan: { inCount: number; outCount: number; neighbors: string[] }) =>
    `${label} is used by ${fan.inCount} files and uses ${fan.outCount} files; connected to: ${fan.neighbors.slice(0, SUMMARY_FAN_EACH).join(", ") || "(none)"}`;
  const edges = input.edges
    .map((e) => `- ${edgeKindPlain(e.kind)}${e.via.length > 0 ? `: ${e.via.join("; ")}` : ""}`)
    .join("\n");
  const content = (label: string, text: string) =>
    text.length > 0
      ? `${label} (first ${SUMMARY_BELT_CONTENT_CHARS} chars):\n${text.slice(0, SUMMARY_BELT_CONTENT_CHARS)}`
      : `${label}: (not shown)`;
  return [
    "You explain ONE connection between two files.",
    PLAIN_RULES,
    "Do not use tools. Reply with ONLY this JSON object (no other text, no code fences):",
    '{"flows": "<what the first file gets from the second>", "why": "<why the first file needs it>", "broke": "<what stops working>"}',
    "At most 40 words per value.",
    "Use only the context below. If something is unclear, say so plainly.",
    "",
    `FROM: ${input.fromPath} (${fan("it", input.fromFan)})`,
    content("FIRST FILE CONTENT", input.fromContent),
    `TO: ${input.toPath} (${fan("it", input.toFan)})`,
    content("SECOND FILE CONTENT", input.toContent),
    `CONNECTIONS ON THIS PAIR:\n${edges}`,
  ].join("\n");
}

/** Cache key: the full prompt hashed (prompt embeds all content). */
export function summaryKey(prompt: string): string {
  return createHash("sha1").update(prompt).digest("hex");
}

export type CachedSummary = { text: string; generatedAt: string };

/** Tiny FIFO cache: oldest entries evicted past the cap. */
export class SummaryCache<T extends { generatedAt: string } = CachedSummary> {
  private readonly store = new Map<string, T>();
  constructor(private readonly cap: number = SUMMARY_CACHE_SIZE) {}
  get(key: string): T | undefined {
    return this.store.get(key);
  }
  set(key: string, value: T): void {
    if (!this.store.has(key) && this.store.size >= this.cap) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, value);
  }
  get size(): number {
    return this.store.size;
  }
}

export class SummaryError extends Error {}

/** Unary spawn seam (tests inject fakes; production uses Bun). */
export type RunSpawn = (cmd: string[]) => {
  /** Resolves with full stdout/stderr/exit once the process ends. */
  result(): Promise<{ out: string; err: string; code: number | null }>;
  kill(): void;
};

const defaultSpawn: RunSpawn = (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
  return {
    async result() {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      return { out, err, code };
    },
    kill: killGroup,
  };
};

export type RunSummaryOpts = {
  prompt: string;
  workspace: string;
  /** Human label for stub output + errors (path or pair). */
  label: string;
  timeoutMs?: number;
  command?: string;
  spawn?: RunSpawn;
};

const truncateText = (text: string): string =>
  text.length > SUMMARY_TEXT_CHARS ? `${text.slice(0, SUMMARY_TEXT_CHARS - 1)}…` : text;

const SUMMARY_FIELD_SETS = [
  { keys: ["what", "why", "fits"], labels: ["What it does:", "Why it matters:", "How it fits:"] },
  { keys: ["flows", "why", "broke"], labels: ["What flows:", "Why it exists:", "If it broke:"] },
];

/**
 * Structured answer (the pydantic-style seam): the prompt demands
 * one JSON object with a fixed key set. Returns the three labeled
 * lines (the newlines are ours, guaranteed) or undefined when the
 * answer is not usable JSON — the caller falls back to raw text.
 * Tolerates fenced and prose-wrapped answers; values must be
 * non-empty strings, otherwise the whole answer is rejected (a
 * partial render would silently drop the model's words).
 */
export function formatSummaryJson(raw: string): string | undefined {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) text = (fence[1] ?? "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const rec = obj as Record<string, unknown>;
  const set = SUMMARY_FIELD_SETS.find((s) =>
    s.keys.every((k) => typeof rec[k] === "string" && (rec[k] as string).trim().length > 0),
  );
  if (!set) return undefined;
  return set.keys.map((k, i) => `${set.labels[i]} ${(rec[k] as string).trim()}`).join("\n");
}

/**
 * Line-break fallback for non-JSON answers: when all three labels
 * of either set are present mid-paragraph, split before each —
 * the UI keeps the breaks (pre-line). Anything else passes
 * through untouched.
 */
export function breakSummaryLines(text: string): string {
  const labels = SUMMARY_FIELD_SETS.map((s) => s.labels).find((set) => set.every((label) => text.includes(label)));
  if (!labels) return text;
  const [, second, third] = labels as [string, string, string];
  const cut = (hay: string, label: string): string => {
    const at = hay.indexOf(label);
    if (at <= 0 || hay[at - 1] === "\n") return hay;
    return `${hay.slice(0, at).trimEnd()}\n${hay.slice(at)}`;
  };
  return cut(cut(text, second), third);
}

export type RunAgentOpts = {
  prompt: string;
  workspace: string;
  /** Human label for stub output + errors (path, pair, or floor). */
  label: string;
  timeoutMs: number;
  command?: string;
  spawn?: RunSpawn;
};

/**
 * Raw agent run: prompt via temp file (never argv), trimmed
 * stdout. Throws SummaryError on stub error, timeout, nonzero
 * exit, or empty output — never returns blank. Callers format.
 */
export async function runAgentText(opts: RunAgentOpts): Promise<string> {
  const stub = process.env.ARTIFEX_SUMMARY_STUB;
  if (stub === "1") return `STUB summary for ${opts.label}`;
  if (stub === "error") throw new SummaryError("stub failure");
  const promptDir = `${tmpdir()}/artifex-prompts`;
  mkdirSync(promptDir, { recursive: true });
  const promptFile = `${promptDir}/summary-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`;
  writeFileSync(promptFile, `${opts.prompt}\n`);
  const timeoutMs = opts.timeoutMs;
  const child = (opts.spawn ?? defaultSpawn)([
    opts.command ?? "muse",
    "exec",
    "--prompt-file",
    promptFile,
    "--workspace",
    opts.workspace,
    "--reasoning-effort",
    summaryEffort(),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new SummaryError(`summary timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    const { out, err, code } = await Promise.race([child.result(), watchdog]);
    if (code !== 0) throw new SummaryError(`summarizer exited ${code ?? "?"}: ${err.trim().slice(0, 300) || "no output"}`);
    const trimmed = out.trim();
    if (!trimmed) throw new SummaryError("summarizer returned empty output");
    return trimmed;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    rmSync(promptFile, { force: true });
  }
}

/**
 * One summary run: raw agent text, then the labeled-lines format
 * capped for the UI. Throws SummaryError — never returns blank.
 */
export async function runSummary(opts: RunSummaryOpts): Promise<{ text: string }> {
  const trimmed = await runAgentText({
    prompt: opts.prompt,
    workspace: opts.workspace,
    label: opts.label,
    timeoutMs: opts.timeoutMs ?? SUMMARY_TIMEOUT_MS,
    command: opts.command,
    spawn: opts.spawn,
  });
  return { text: truncateText(breakSummaryLines(formatSummaryJson(trimmed) ?? trimmed)) };
}
