/**
 * Muse intent adapter (ghost layer, eng review D8/D20, T1 spike
 * F1/F3/F8). Spawns `muse exec --json` with the standing elicitation
 * instruction, normalizes its JSONL stdout into FloorEvents, and
 * reports process lifecycle for the worker chip.
 *
 * Measured channel (spike/RESULTS.md, muse-elicited, precision 3/3,
 * recall 3/3, 29 s median lead): `todo.snapshot.updated` fires before
 * the corresponding writes — the only intent channel this adapter
 * claims. Todo items are free text, so paths come from a
 * deterministic token regex over each item's text. Extraction only
 * accepts tokens carrying real path evidence: a directory separator,
 * a known file extension, or a known extensionless filename
 * (package.json, Makefile, ...). A bare word with no such evidence is
 * NEVER promoted to a path — free keywords like "bun" must not spawn
 * ghosts. Because extraction can still disagree with what the agent
 * actually creates, every produced `planned` event carries the
 * original item texts in `steps` as evidence for the inspector.
 *
 * Trust boundary (events/index.ts): this adapter is trusted local
 * code; agent output reaches the events contract only through here.
 * Path safety itself is the validator's repo-relative rule — this
 * module reuses `validateFloorEvent` to make path-shaped garbage
 * throw rather than mirror the check (mirrors parser/extract.ts).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  EVENTS_VERSION,
  validateFloorEvent,
  MAX_TEXT_CHARS,
  type FloorEvent,
} from "../events/index.ts";

export const MUSE_AGENT_ID = "muse";

/**
 * Standing elicitation instruction, verbatim from the measured spike
 * (spike/RESULTS.md § Friction F3). Wording changes must re-run the
 * spike harness before they ship — lead time was measured against
 * this exact text.
 */
export const ELICITATION_INSTRUCTION =
  "Before writing any file, first record a todo/plan listing the exact relative file paths you will create or modify.";

/**
 * Extensions that give a bare token file-path evidence. Conservative
 * on purpose: an unlisted extension only extracts when the token
 * also contains a directory separator.
 */
const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "py", "pyi", "java", "kt", "kts", "go", "rs", "c", "h", "cc", "cpp",
  "hpp", "cs", "rb", "php", "swift", "scala", "sh", "bash", "zsh",
  "md", "mdx", "txt", "html", "htm", "css", "scss", "less", "yaml",
  "yml", "toml", "xml", "sql", "properties", "gradle", "lock", "env",
]);

/** Extensionless filenames that are paths by convention, not keywords. */
const KNOWN_FILENAMES = new Set([
  "makefile", "dockerfile", "containerfile", "gemfile", "rakefile",
  "procfile", "vagrantfile", "justfile", "cmakelists.txt",
]);

/**
 * Token shape for a repo-relative POSIX path. Backslashes and URLs
 * are excluded up front; `..`/`.`/empty segments are excluded by the
 * segment shape (first char alnum/_/@, no all-dots segment).
 */
// The third alternative (bare word) exists only so known
// extensionless filenames (Makefile, Dockerfile) can extract; the
// evidence check below drops every other bare word.
const PATH_TOKEN_RE =
  /[A-Za-z0-9_@][A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_@][A-Za-z0-9_.@+-]*)+|[A-Za-z0-9_@][A-Za-z0-9_.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}|[A-Za-z][A-Za-z0-9_-]{2,}/g;

function cleanToken(token: string): string | undefined {
  // Strip sentence punctuation glued to the token ("edit src/x.ts.")
  // — trailing dots after a real extension, closers, commas, colons.
  const t = token.replace(/[),;:!?]+$/, "").replace(/\.+$/, "");
  if (t.length < 2) return undefined;
  if (t.includes("://")) return undefined;
  return t;
}

/**
 * Deterministically extract repo-relative paths from one todo item's
 * free text. Pure: no I/O, no clock. Backticked/quoted segments are
 * scanned too (the token regex skips the punctuation around them).
 */
export function extractPathsFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.matchAll(PATH_TOKEN_RE)) {
    const token = cleanToken(raw[0]);
    if (token === undefined) continue;
    const segments = token.split("/");
    const leaf = segments[segments.length - 1]!;
    const dot = leaf.lastIndexOf(".");
    const ext = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
    const hasDir = segments.length > 1;
    const knownLeaf = KNOWN_FILENAMES.has(leaf.toLowerCase());
    // Path evidence: directory separator, known extension, or a
    // conventional filename. Anything else (a bare keyword, a
    // version like "1.2.3", a hostname like "example.com") is not
    // a path and stays unextracted.
    if (!hasDir && !KNOWN_EXTENSIONS.has(ext) && !knownLeaf) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export type TodoItem = {
  index: number;
  status: string;
  text: string;
};

export type MuseStreamEvent =
  | { kind: "todo"; sessionId: string | undefined; items: TodoItem[]; revision: number | undefined }
  | { kind: "activity"; payloadType: string }
  | { kind: "terminal"; payloadType: string }
  | { kind: "other"; payloadType: string };

/**
 * Parse one line of `muse exec --json` stdout. Returns undefined
 * for blank or non-object JSON. Unknown payload types stay visible
 * as "other" — never silently dropped.
 */
export function parseMuseLine(line: string): MuseStreamEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "other", payloadType: "non-json" };
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "other", payloadType: "non-object" };
  const rec = parsed as Record<string, unknown>;
  const payloadType = typeof rec.payload_type === "string" ? rec.payload_type : "unknown";
  if (payloadType.startsWith("run.terminal.")) return { kind: "terminal", payloadType };
  if (payloadType.startsWith("task.lifecycle.") || payloadType === "tool.result") {
    return { kind: "activity", payloadType };
  }
  if (payloadType === "todo.snapshot.updated") {
    const stream = rec.stream as Record<string, unknown> | undefined;
    const sessionId = typeof stream?.id === "string" ? stream.id : undefined;
    const payload = rec.payload as Record<string, unknown> | undefined;
    const facts = payload?.facts as Record<string, unknown> | undefined;
    const rawItems = Array.isArray(facts?.items) ? facts.items : [];
    const items: TodoItem[] = [];
    for (const raw of rawItems) {
      if (raw === null || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      items.push({
        index: typeof r.index === "number" ? r.index : items.length,
        status: typeof r.status === "string" ? r.status : "pending",
        text: typeof r.text === "string" ? r.text : "",
      });
    }
    const revision = typeof facts?.revision_id === "number" ? facts.revision_id : undefined;
    return { kind: "todo", sessionId, items, revision };
  }
  return { kind: "other", payloadType };
}

/** The current step for the worker chip: first in-progress item, else first pending. */
export function currentStep(items: readonly TodoItem[]): string | undefined {
  const live = items.find((i) => i.status === "in_progress") ?? items.find((i) => i.status === "pending");
  return live?.text;
}

/**
 * Build a validated `planned` event from one todo snapshot, or
 * undefined when no item carries an extractable path. Items already
 * marked completed are skipped for paths but kept in `steps` as
 * evidence of the whole plan as stated.
 */
export function plannedEventFromTodo(args: {
  sessionId: string;
  planId: string;
  items: readonly TodoItem[];
  ts: number;
  id: string;
}): FloorEvent | undefined {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of args.items) {
    if (item.status === "completed" || item.status === "cancelled") continue;
    for (const p of extractPathsFromText(item.text)) {
      if (seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  if (paths.length === 0) return undefined;
  const steps = args.items
    .map((i) => i.text.slice(0, MAX_TEXT_CHARS))
    .filter((t) => t.length > 0);
  try {
    return validateFloorEvent({
      v: EVENTS_VERSION,
      id: args.id,
      ts: args.ts,
      sessionId: args.sessionId,
      agentId: MUSE_AGENT_ID,
      type: "planned",
      provenance: "intended",
      planId: args.planId,
      channel: "todo",
      paths,
      ...(steps.length > 0 ? { steps } : {}),
    });
  } catch {
    // A path-shaped token the contract rejects (absolute, `..`):
    // drop the whole plan rather than guess which path was meant.
    // Extraction never silently rewrites agent-stated paths.
    return undefined;
  }
}

export type AgentRun = {
  /** Kill the whole process group (SIGTERM, then SIGKILL after grace). */
  stop(): void;
};

export type AgentCallbacks = {
  onLine(event: MuseStreamEvent): void;
  onStderr(text: string): void;
  /** Terminal payload seen, or the process exited without one. */
  onExit(info: { code: number | null; timedOut: boolean; sawTerminal: boolean }): void;
};

/**
 * Spawn seam for tests: anything line-shaped can drive the adapter.
 * Returns a readable line stream plus exit + kill plumbing.
 */
export type SpawnFn = (cmd: string[]) => {
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  exited: Promise<number | null>;
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
};

async function* linesOf(stream: ReadableStream<Uint8Array> | undefined): AsyncGenerator<string> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = carry.indexOf("\n")) >= 0) {
        yield carry.slice(0, idx);
        carry = carry.slice(idx + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
  carry += decoder.decode();
  if (carry.length > 0) yield carry;
}

const defaultSpawn: SpawnFn = (cmd) => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Own process group so a stop kills the agent's shell children
    // too, never just the wrapper.
    detached: true,
  });
  return {
    stdout: linesOf(proc.stdout as ReadableStream<Uint8Array>),
    stderr: linesOf(proc.stderr as ReadableStream<Uint8Array>),
    exited: proc.exited,
    killGroup(signal) {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
        } catch { /* already gone */ }
      }
    },
  };
};

const STOP_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run one dispatch: spawn `muse exec --json --yolo` against the
 * workspace with the elicitation instruction prepended, streaming
 * normalized events to the caller. The prompt travels via
 * --prompt-file (a temp file outside the workspace, removed after
 * spawn) so prompt text never appears in process listings and no
 * argv-length limit applies.
 *
 * --yolo: dispatch is an explicit human action from the
 * token-authenticated local console; approvals are bypassed exactly
 * as the measured spike ran. The README states this plainly.
 */
export function startMuseRun(args: {
  workspace: string;
  sessionId: string;
  prompt: string;
  callbacks: AgentCallbacks;
  command?: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}): AgentRun {
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const promptDir = `${tmpdir()}/artifex-prompts`;
  const promptFile = `${promptDir}/${args.sessionId}.txt`;
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(promptFile, `${ELICITATION_INSTRUCTION}\n\n${args.prompt}\n`);
  const cmd = [
    args.command ?? "muse",
    "exec", "--json", "--yolo",
    "--workspace", args.workspace,
    "--session-id", args.sessionId,
    "--prompt-file", promptFile,
  ];
  const child = spawnFn(cmd);
  let sawTerminal = false;
  let stopped = false;
  const killer = setTimeout(() => {
    stopped = true;
    child.killGroup("SIGKILL");
  }, timeoutMs);
  const done = (async () => {
    try {
      await Promise.all([
        (async () => {
          for await (const line of child.stdout) {
            const event = parseMuseLine(line);
            if (!event) continue;
            if (event.kind === "terminal") sawTerminal = true;
            args.callbacks.onLine(event);
          }
        })(),
        (async () => {
          for await (const chunk of child.stderr) args.callbacks.onStderr(chunk);
        })(),
      ]);
      const code = await child.exited;
      clearTimeout(killer);
      try { rmSync(promptFile); } catch { /* already gone */ }
      args.callbacks.onExit({ code, timedOut: stopped, sawTerminal });
    } catch {
      clearTimeout(killer);
      try { rmSync(promptFile); } catch { /* already gone */ }
      args.callbacks.onExit({ code: null, timedOut: stopped, sawTerminal });
    }
  })();
  void done;
  return {
    stop() {
      stopped = true;
      child.killGroup("SIGTERM");
      const grace = setTimeout(() => child.killGroup("SIGKILL"), STOP_GRACE_MS);
      void child.exited.finally(() => clearTimeout(grace));
    },
  };
}

