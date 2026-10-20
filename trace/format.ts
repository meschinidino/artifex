/**
 * Structural trace export formatter: one file's neighborhood as
 * compact markdown with `path:line` anchors and no source code, for
 * agent context. Pure: deterministic output for a given input, no
 * clock reads (no timestamps — two exports of an unchanged floor
 * diff empty), no I/O, no runtime imports. One builder serves both
 * surfaces (the inspector "Copy trace" button and
 * `floor.getTrace`); the server assembles the input facts for each.
 *
 * The format is normative in
 * specs/2026-10-19-trace-export/requirements.md (FR1–FR12).
 */

/** Per-section entry cap; overflow renders as a `+N more` line. */
export const TRACE_SECTION_CAP = 50;
/** Total output cap in UTF-8 bytes; overflow stops at a section boundary. */
export const TRACE_TOTAL_BYTES = 32 * 1024;

/**
 * `line` is null when the edge is proven but has no import
 * statement line: JVM type uses resolved through the same package
 * or a wildcard import (`import pkg.*`), which no single statement
 * cites. Null renders as `(type use, no import line)` — never a
 * false `none` (FR3/FR4, NFR3).
 */
export type TraceImportEntry = { target: string; line: number | null };
export type TraceDependentEntry = { path: string; line: number | null };
export type TraceEndpointTable = { table: string; access: string };
export type TraceEndpointCaller = { path: string; line: number; caller: string; via: string };
export type TraceEndpointEntry = {
  method: string;
  route: string;
  line: number;
  handler: string;
  tables: TraceEndpointTable[];
  callers: TraceEndpointCaller[];
};
export type TraceCallEntry = {
  method: string;
  path: string;
  line: number;
  via: string;
  caller: string;
  matchedPath?: string;
  targetService?: string;
};
export type TraceTableEntry = {
  table: string;
  access: string;
  via: string;
  through: string;
  implicit: boolean;
};
export type TraceTopicEntry = { topic: string; direction: string; handler: string; peers: string[] };

export type TraceUnprovenReason = "parse-error" | "unparsed" | "binary";

export type TraceInput = {
  /** Exporting file's floor path. */
  path: string;
  /** Floor repo label ("" renders as `(single)`). */
  repo: string;
  /**
   * Own resolved in-repo imports, or the reason they are unproven
   * (parse error, unparsed, binary) — never an empty claim of zero
   * imports for a file whose imports were never proven.
   */
  imports: TraceImportEntry[] | { unproven: TraceUnprovenReason };
  importedBy: TraceDependentEntry[];
  endpoints: TraceEndpointEntry[];
  callsOut: TraceCallEntry[];
  /** Directly-used tables only (transitive reachability stays in the inspector). */
  tables: TraceTableEntry[];
  topics: TraceTopicEntry[];
  unresolvedImports: number;
  unresolvedDynamics: number;
};

/** Bytewise order (the T5 `byPath` precedent): ASCII paths sort as bytes. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Source-derived strings (paths, routes, handlers, tables, topics)
 * are untrusted repo content: sanitize every one before it renders,
 * so a hostile filename cannot inject markdown structure or extra
 * lines into exported agent context (FR11).
 */

/** Control characters, DEL, and unicode line breaks: never renderable. */
const CONTROL_CHARS = /[\x00-\x1F\x7F\u2028\u2029]/;
const CONTROL_CHARS_ALL = /[\x00-\x1F\x7F\u2028\u2029]/g;
/**
 * Mid-line markdown metacharacters. Every rendered value sits
 * mid-line behind a fixed `- `/`←`/`#` prefix, so only these need
 * backslash-escaping; plain paths, routes, and names pass through
 * byte-identical.
 */
const MARKDOWN_SPECIAL = /[\\`*_~[\]()<>!|]/g;
/** D18 mask token, local: trace/ ships no runtime imports (NFR1). */
const MASKED_VALUE = "[masked]";
const MASKED_VALUE_ESCAPED = /\\\[masked\\\]/g;
/** `name=value` whose name is secret-bearing (the D18 keyword set). */
const SECRET_PAIR = /([A-Za-z0-9_.~-]*(?:key|token|secret|password)[A-Za-z0-9_.~-]*=)[^/;]*/gi;

function escapeMarkdown(s: string): string {
  return s.replace(MARKDOWN_SPECIAL, "\\$&");
}

/** Clean one rendered field; undefined drops the entry (control chars). */
function cleanField(raw: string): string | undefined {
  if (CONTROL_CHARS.test(raw)) return undefined;
  return escapeMarkdown(raw);
}

/**
 * Clean a route/call path: query strings and fragments (and their
 * values, e.g. `?api_key=secret`) never render; secret-bearing
 * `name=value` segments mask to `[masked]` (D18). Masking runs on
 * the bare text (full-fidelity name matching), then escaping, then
 * the mask token is restored — an attacker-crafted `\[masked\]`
 * collapses to the same inert token, so the restore leaks nothing.
 */
function cleanUrlField(raw: string): string | undefined {
  const cut = raw.search(/[?#]/);
  const bare = cut === -1 ? raw : raw.slice(0, cut);
  if (CONTROL_CHARS.test(bare)) return undefined;
  return escapeMarkdown(bare.replace(SECRET_PAIR, "$1[masked]")).replace(MASKED_VALUE_ESCAPED, MASKED_VALUE);
}

/**
 * Clean an identity field (export path, repo label): these cannot
 * drop — the export names its file or it names nothing — so control
 * characters substitute instead.
 */
function cleanIdentity(raw: string): string {
  return escapeMarkdown(raw.replace(CONTROL_CHARS_ALL, "\uFFFD"));
}

/** Sanitize every source-derived string; drop unrenderable entries. */
function sanitizeInput(input: TraceInput): TraceInput {
  const path = cleanIdentity(input.path);
  const repo = cleanIdentity(input.repo);
  const imports = Array.isArray(input.imports)
    ? input.imports.flatMap((e) => {
      const target = cleanField(e.target);
      return target === undefined ? [] : [{ target, line: e.line }];
    })
    : input.imports;
  const importedBy = input.importedBy.flatMap((e) => {
    const dep = cleanField(e.path);
    return dep === undefined ? [] : [{ path: dep, line: e.line }];
  });
  const endpoints = input.endpoints.flatMap((ep) => {
    const method = cleanField(ep.method);
    const route = cleanUrlField(ep.route);
    const handler = cleanField(ep.handler);
    if (method === undefined || route === undefined || handler === undefined) return [];
    const tables = ep.tables.flatMap((t) => {
      const table = cleanField(t.table);
      const access = cleanField(t.access);
      return table === undefined || access === undefined ? [] : [{ table, access }];
    });
    const callers = ep.callers.flatMap((c) => {
      const callerPath = cleanField(c.path);
      const caller = cleanField(c.caller);
      const via = cleanField(c.via);
      return callerPath === undefined || caller === undefined || via === undefined
        ? []
        : [{ path: callerPath, line: c.line, caller, via }];
    });
    return [{ method, route, line: ep.line, handler, tables, callers }];
  });
  const callsOut = input.callsOut.flatMap((c) => {
    const method = cleanField(c.method);
    const callPath = cleanUrlField(c.path);
    const via = cleanField(c.via);
    const caller = cleanField(c.caller);
    const matchedPath = c.matchedPath === undefined ? undefined : cleanField(c.matchedPath);
    const targetService = c.targetService === undefined ? undefined : cleanField(c.targetService);
    if (
      method === undefined || callPath === undefined || via === undefined || caller === undefined ||
      (c.matchedPath !== undefined && matchedPath === undefined) ||
      (c.targetService !== undefined && targetService === undefined)
    ) {
      return [];
    }
    return [{
      method,
      path: callPath,
      line: c.line,
      via,
      caller,
      ...(matchedPath !== undefined ? { matchedPath } : {}),
      ...(targetService !== undefined ? { targetService } : {}),
    }];
  });
  const tables = input.tables.flatMap((t) => {
    const table = cleanField(t.table);
    const access = cleanField(t.access);
    const via = cleanField(t.via);
    const through = cleanField(t.through);
    return table === undefined || access === undefined || via === undefined || through === undefined
      ? []
      : [{ table, access, via, through, implicit: t.implicit }];
  });
  const topics = input.topics.flatMap((t) => {
    const topic = cleanField(t.topic);
    const direction = cleanField(t.direction);
    const handler = cleanField(t.handler);
    if (topic === undefined || direction === undefined || handler === undefined) return [];
    const peers = t.peers.flatMap((p) => {
      const peer = cleanField(p);
      return peer === undefined ? [] : [peer];
    });
    return [{ topic, direction, handler, peers }];
  });
  return {
    path,
    repo,
    imports,
    importedBy,
    endpoints,
    callsOut,
    tables,
    topics,
    unresolvedImports: input.unresolvedImports,
    unresolvedDynamics: input.unresolvedDynamics,
  };
}

function renderEndpoint(path: string, ep: TraceEndpointEntry): string[] {
  const tables = [...ep.tables].sort((a, b) => byString(a.table, b.table));
  const suffix = tables.length > 0 ? ` → tables: ${tables.map((t) => `${t.table} (${t.access})`).join(", ")}` : "";
  const lines = [`- ${ep.method} ${ep.route} ${path}:${ep.line} → ${ep.handler || "?"}${suffix}`];
  const callers = [...ep.callers].sort(
    (a, b) => byString(a.path, b.path) || a.line - b.line || byString(a.caller, b.caller) || byString(a.via, b.via),
  );
  for (const c of callers) {
    lines.push(c.caller === "" ? `  ← ${c.path}:${c.line} (${c.via})` : `  ← ${c.path}:${c.line} ${c.caller} (${c.via})`);
  }
  return lines;
}

function renderCall(path: string, c: TraceCallEntry): string {
  const dest = c.matchedPath ?? (c.targetService ? `${c.targetService} (not in indexed repos)` : "unresolved");
  const via = c.caller === "" ? `(${c.via})` : `(${c.via}, ${c.caller})`;
  return `- ${c.method} ${c.path} ${path}:${c.line} ${via} → ${dest}`;
}

function renderTable(t: TraceTableEntry): string {
  return `- ${t.table} ${t.access} via ${t.via} through ${t.through}${t.implicit ? " (implicit name)" : ""}`;
}

function renderTopic(t: TraceTopicEntry): string {
  const handler = t.handler === "" ? "" : ` (${t.handler})`;
  const peers = t.peers.length > 0 ? ` · peers: ${[...t.peers].sort(byString).join(", ")}` : "";
  return `- ${t.topic} ${t.direction}${handler}${peers}`;
}

/**
 * Render one section body with the 50-entry cap. Entries are atomic:
 * an endpoint's caller lines ride with it (never orphaned, never
 * counted separately); overflow appends `+N more` with N the
 * remaining entry count while the title count stays truthful.
 */
function capped<T>(entries: readonly T[], render: (e: T) => string[]): string[] {
  const shown = entries.slice(0, TRACE_SECTION_CAP);
  const lines = shown.flatMap(render);
  if (entries.length > TRACE_SECTION_CAP) lines.push(`+${entries.length - TRACE_SECTION_CAP} more`);
  return lines;
}

type Section = { title: string; lines: string[] };

function buildSections(clean: TraceInput): Section[] {
  // Input arrives pre-sanitized (sanitize exactly once: escaping is
  // not idempotent). Counts, caps, and order all reflect rendered
  // bytes, and dropped entries never leak through any path.
  // Unlined entries sort after lined ones within a target.
  const byLine = (a: number | null, b: number | null): number => (a ?? Infinity) - (b ?? Infinity);
  const imports = Array.isArray(clean.imports)
    ? [...clean.imports].sort((a, b) => byString(a.target, b.target) || byLine(a.line, b.line))
    : undefined;
  const importedBy = [...clean.importedBy].sort((a, b) => byString(a.path, b.path) || byLine(a.line, b.line));
  const endpoints = [...clean.endpoints].sort(
    (a, b) => byString(a.route, b.route) || byString(a.method, b.method) || a.line - b.line,
  );
  const callsOut = [...clean.callsOut].sort(
    (a, b) => byString(a.path, b.path) || a.line - b.line || byString(a.method, b.method),
  );
  const tables = [...clean.tables].sort((a, b) => byString(a.table, b.table));
  const topics = [...clean.topics].sort((a, b) => byString(a.topic, b.topic));

  const renderImport = (e: { target: string; line: number | null }): string[] =>
    e.line === null ? [`- ${e.target} (type use, no import line)`] : [`- ${e.target}:${e.line}`];
  const renderDependent = (e: { path: string; line: number | null }): string[] =>
    e.line === null ? [`- ${e.path} (type use, no import line)`] : [`- ${e.path}:${e.line}`];

  const sections: Section[] = [
    imports === undefined
      ? { title: "## imports (?)", lines: [`unproven (${(clean.imports as { unproven: string }).unproven})`] }
      : {
          title: `## imports (${imports.length})`,
          lines: imports.length === 0 ? ["none"] : capped(imports, renderImport),
        },
    {
      title: `## imported by (${importedBy.length})`,
      lines: importedBy.length === 0 ? ["none"] : capped(importedBy, renderDependent),
    },
    {
      title: `## endpoints (${endpoints.length})`,
      lines: endpoints.length === 0 ? ["none"] : capped(endpoints, (e) => renderEndpoint(clean.path, e)),
    },
    {
      title: `## calls out (${callsOut.length})`,
      lines: callsOut.length === 0 ? ["none"] : capped(callsOut, (c) => [renderCall(clean.path, c)]),
    },
    {
      title: `## tables (${tables.length})`,
      lines: tables.length === 0 ? ["none"] : capped(tables, (t) => [renderTable(t)]),
    },
    {
      title: `## topics (${topics.length})`,
      lines: topics.length === 0 ? ["none"] : capped(topics, (t) => [renderTopic(t)]),
    },
  ];
  // The only omissible section: present only when something is
  // unresolved, with a count line per nonzero kind.
  const unresolved: string[] = [];
  if (clean.unresolvedImports > 0) unresolved.push(`${clean.unresolvedImports} unresolved import(s)`);
  if (clean.unresolvedDynamics > 0) unresolved.push(`${clean.unresolvedDynamics} dynamic connection(s) not guessed`);
  if (unresolved.length > 0) sections.push({ title: "## unresolved", lines: unresolved });
  return sections;
}

/**
 * Format one file's trace export. Output is LF markdown with every
 * line terminated (trailing newline), deterministic for a given
 * input: every list is sorted inside, so caller map-iteration order
 * can never leak through.
 */
export function formatTrace(input: TraceInput): string {
  const clean = sanitizeInput(input);
  const header = [`# trace: ${clean.path}`, `floor: ${clean.repo === "" ? "(single)" : clean.repo}`];
  const sections = buildSections(clean);
  const bytes = (lines: string[]): number => Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
  const full = [...header, ...sections.flatMap((s) => [s.title, ...s.lines])];
  if (bytes(full) <= TRACE_TOTAL_BYTES) return `${full.join("\n")}\n`;
  // Over budget: stop at a section boundary with a marker line
  // rather than cutting a row. Sections are atomic — when even the
  // next whole section stops fitting, it and everything after it
  // are replaced by the marker (0 rendered is honest, a cut row is
  // not). The header always renders: without it the artifact names
  // nothing.
  const kept: string[] = [...header];
  let count = 0;
  for (const s of sections) {
    const candidate = [...kept, s.title, ...s.lines];
    const marker = `… truncated (${count + 1} of ${sections.length} sections)`;
    if (bytes([...candidate, marker]) > TRACE_TOTAL_BYTES) break;
    kept.push(s.title, ...s.lines);
    count++;
  }
  kept.push(`… truncated (${count} of ${sections.length} sections)`);
  return `${kept.join("\n")}\n`;
}
