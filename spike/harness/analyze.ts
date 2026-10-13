/**
 * T1 spike analysis: for each written file, find the first stdout line that
 * mentions its path BEFORE the file was first seen on disk, classify that
 * mention (plan / tool-call / text) from the parsed event structure (never
 * from payload substrings: file content containing "TODO" is not a plan),
 * and compute lead time. Also extracts planned paths from plan-class
 * lines to compute planned-vs-written precision for this run.
 *
 * Usage: bun run spike/harness/analyze.ts spike/captures/<agent>.json
 */
import { readFileSync, writeFileSync } from "node:fs";

type Capture = {
  agent: string;
  durationMs: number;
  exitCode: number | null;
  lines: { t: number; stream: string; line: string }[];
  files: Record<string, { firstSeenMs: number; mtimeMs: number; size: number }>;
};

type Rec = Record<string, unknown>;

function parse(line: string): Rec | null {
  try {
    const e = JSON.parse(line);
    return typeof e === "object" && e !== null ? (e as Rec) : null;
  } catch {
    return null;
  }
}

function eventKind(e: Rec | null): string {
  if (!e) return "non-json";
  const payload = (e.payload ?? {}) as Rec;
  return String(e.payload_type ?? e.type ?? e.kind ?? e.event ?? e.method ?? payload.type ?? "json");
}

/**
 * Classify by event structure per agent stream shape. Returns:
 * plan | tool-call | text/other | prompt | tool-result | other
 */
function classify(e: Rec | null): string {
  if (!e) return "text/other";
  const kind = eventKind(e);
  const payload = (e.payload ?? {}) as Rec;
  const ev = (payload.event ?? {}) as Rec;

  // Prompt echoes are not agent intent.
  if (kind === "turn.input.user") return "prompt";

  // Muse exec --json
  if (kind === "todo.snapshot.updated") return "plan";
  if (typeof ev.operation === "string" && ev.operation.startsWith("tool:")) return "tool-call";
  if (kind === "tool.result" || kind === "task.lifecycle.output") return "tool-result";
  if (kind === "run.output.delta") return "text/other";

  // Claude Code stream-json
  if (kind === "assistant") {
    const content = ((e.message ?? {}) as Rec).content;
    if (Array.isArray(content)) {
      let sawText = false;
      for (const b of content as Rec[]) {
        if (b.type === "text") sawText = true;
        if (b.type === "tool_use") {
          const name = String(b.name ?? "");
          const input = (b.input ?? {}) as Rec;
          if (["TodoWrite", "TaskCreate", "TaskUpdate"].includes(name)) return "plan";
          if (name === "Write" && String(input.file_path ?? "").includes("/.claude/plans/")) return "plan";
          return "tool-call";
        }
      }
      return sawText ? "text/other" : "other";
    }
    return "text/other";
  }
  if (kind === "user") return "tool-result";
  if (kind === "result") return "text/other";

  // Codex exec --json
  const item = (e.item ?? {}) as Rec;
  if (kind === "item.started" || kind === "item.completed") {
    const t = String(item.type ?? "");
    if (t.includes("plan")) return "plan";
    if (t === "file_change" || t === "command_execution") return "tool-call";
    if (t === "agent_message") return "text/other";
    return "other";
  }
  return "other";
}

const PATH_RE = /[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.(?:ts|tsx|js|mjs|py|json|md)\b/g;

function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: analyze.ts <capture.json>");
  const cap: Capture = JSON.parse(readFileSync(path, "utf8"));

  const parsed = cap.lines.map((l) => ({ ...l, e: parse(l.line) }));
  const kinds = new Map<string, number>();
  for (const l of parsed) if (l.stream === "stdout") {
    const k = eventKind(l.e);
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }

  const written = Object.keys(cap.files).filter(
    (f) => f !== ".git" && !f.startsWith(".git/") && f !== "README.md",
  );
  const rows = written.map((f) => {
    const base = f.split("/").pop() ?? f;
    const writeT = cap.files[f].firstSeenMs;
    let firstAny: { t: number; kind: string; cls: string } | null = null;
    let firstPlanText: { t: number; kind: string; cls: string } | null = null;
    const baseRe = new RegExp(`(?<![\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    for (const l of parsed) {
      if (l.stream !== "stdout" || l.t >= writeT) continue;
      const cls = classify(l.e);
      if (cls === "prompt" || cls === "tool-result") continue;
      if (l.line.includes(f) || baseRe.test(l.line)) {
        const rec = { t: l.t, kind: eventKind(l.e), cls };
        if (!firstAny) firstAny = rec;
        if (!firstPlanText && (cls === "plan" || cls === "text/other")) firstPlanText = rec;
        if (firstAny && firstPlanText) break;
      }
    }
    return {
      file: f,
      writeMs: writeT,
      firstMentionMs: firstAny?.t ?? null,
      firstMentionClass: firstAny?.cls ?? null,
      firstMentionKind: firstAny?.kind ?? null,
      leadAnyMs: firstAny ? writeT - firstAny.t : null,
      leadPlanTextMs: firstPlanText ? writeT - firstPlanText.t : null,
    };
  });

  // Planned paths named by plan-class lines (for precision this run).
  const plannedPaths = new Set<string>();
  for (const l of parsed) {
    if (l.stream !== "stdout" || classify(l.e) !== "plan") continue;
    for (const m of l.line.matchAll(PATH_RE)) {
      const p = m[0].replace(/^\.\//, "");
      if (!p.includes(".claude/plans/")) plannedPaths.add(p);
    }
  }
  const plannedList = [...plannedPaths].sort();
  const plannedHit = plannedList.filter((p) => written.includes(p));

  const withPlanText = rows.filter((r) => r.leadPlanTextMs !== null);
  const withAny = rows.filter((r) => r.leadAnyMs !== null);
  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const summary = {
    agent: cap.agent,
    durationMs: cap.durationMs,
    exitCode: cap.exitCode,
    stdoutLines: parsed.filter((l) => l.stream === "stdout").length,
    stderrLines: parsed.filter((l) => l.stream === "stderr").length,
    eventKinds: Object.fromEntries(kinds),
    writtenFiles: written,
    rows,
    plannedPathsThisRun: plannedList,
    plannedPrecisionThisRun: plannedList.length ? plannedHit.length / plannedList.length : null,
    matchRateAny: written.length ? withAny.length / written.length : null,
    matchRatePlanText: written.length ? withPlanText.length / written.length : null,
    medianLeadAnyMs: median(withAny.map((r) => r.leadAnyMs as number)),
    medianLeadPlanTextMs: median(withPlanText.map((r) => r.leadPlanTextMs as number)),
  };
  const out = path.replace(/\.json$/, ".summary.json");
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
