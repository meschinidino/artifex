/**
 * Agent-interface read queries (T5): pure result builders over a
 * per-request model the server assembles from live state. No I/O,
 * no sockets, no clock reads — every derivation here is a pure
 * function of the model, so honesty ("unknown" over fabricated,
 * caps over unbounded) is unit-testable without a server.
 */
import type { BuildingConnections, TableRef } from "../connections/graph.ts";
import { MAX_TEXT_CHARS, type FloorEvent } from "../events/index.ts";
import type { ResolvedImport } from "../resolver/resolver.ts";
import { formatTrace, type TraceImportEntry, type TraceInput } from "../trace/format.ts";
import { maskContent } from "../watcher/mask.ts";
import type { AgentNote, AgentStatus, Building, GhostBuilding, RunRecord } from "../floor-ui/wire.ts";

/** Live floor state, snapshotted per agent request. */
export type QueryModel = {
  /** Floor repo label (the snapshot `repo` value); heads the trace export. */
  repo: string;
  buildings: readonly Building[];
  /** Resolved in-repo import targets by importing path. */
  imports: ReadonlyMap<string, readonly string[]>;
  /** Resolved in-repo imports with statement lines, by importing path (trace anchors). */
  importLines: ReadonlyMap<string, readonly ResolvedImport[]>;
  /** Direct-only tables by path: each file's own facts before transitive merging (trace tables). */
  directTables: ReadonlyMap<string, readonly TableRef[]>;
  /** Unresolved-import counts by importing path. */
  unresolved: ReadonlyMap<string, number>;
  /** In-memory event log, oldest first (bounded server-side). */
  events: readonly FloorEvent[];
  /** Stored why-notes, oldest first. */
  notes: readonly AgentNote[];
  ghosts: readonly GhostBuilding[];
  agent: AgentStatus;
  runs: readonly RunRecord[];
  conns: ReadonlyMap<string, BuildingConnections>;
};

export type QueryError = { code: string; message: string };

export type BuildingSummary = {
  path: string;
  zoneId: string;
  band: Building["band"];
  lines: number;
  parse: Building["parse"];
};

export type ChangeRec = {
  ts: number;
  kind: "created" | "modified" | "deleted" | "renamed" | "written";
  fromPath?: string;
};

export type TestState =
  | { status: "pass" | "fail"; passed: number; failed: number; command?: string; ts: number }
  | { status: "unknown" };

export type BuildingDetail = {
  path: string;
  zoneId: string;
  band: Building["band"];
  lines: number;
  bytes: number;
  parse: Building["parse"];
  imports: string[];
  unresolvedImportCount: number;
  dependents: string[];
  recentChanges: ChangeRec[];
  testState: TestState;
  notes: { note: string; ts: number; agentId?: string }[];
};

export type DbSchema = {
  tables: { table: string; usedBy: { path: string; access: string; via: string }[] }[];
  endpoints: { path: string; method: string; route: string; line: number; tables: string[] }[];
  /** False until the T7 schema-view zone ships: reachability only. */
  schemaZoneBuilt: false;
};

/** Recent-changes cap per building: the log is bounded, answers stay small. */
export const RECENT_CHANGES_MAX = 10;

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function listBuildings(model: QueryModel): { total: number; buildings: BuildingSummary[] } {
  const buildings = model.buildings
    .map((b) => ({ path: b.path, zoneId: b.zoneId, band: b.band, lines: b.lines, parse: b.parse }))
    .sort((a, b) => byPath(a.path, b.path));
  return { total: buildings.length, buildings };
}

function recentChangesFor(events: readonly FloorEvent[], path: string): ChangeRec[] {
  const out: ChangeRec[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < RECENT_CHANGES_MAX; i--) {
    const e = events[i]!;
    if (e.type === "observed-change" && e.path === path) {
      out.push({ ts: e.ts, kind: e.change, ...(e.change === "renamed" ? { fromPath: e.fromPath } : {}) });
    } else if (e.type === "file-written" && e.path === path) {
      out.push({ ts: e.ts, kind: "written" });
    }
  }
  return out;
}

function testStateFor(events: readonly FloorEvent[], path: string): TestState {
  // Newest wins; unscoped results (no path) are nobody's building
  // and must never be attributed to one.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "test-result" && e.path === path) {
      return {
        status: e.failed > 0 ? "fail" : "pass",
        passed: e.passed,
        failed: e.failed,
        ...(e.command !== undefined ? { command: e.command } : {}),
        ts: e.ts,
      };
    }
  }
  return { status: "unknown" };
}

export function getBuilding(model: QueryModel, path: string): { result: BuildingDetail } | { error: QueryError } {
  const building = model.buildings.find((b) => b.path === path);
  if (!building) return { error: { code: "unknown-building", message: `unknown building: ${path}` } };
  const dependents: string[] = [];
  for (const [from, targets] of model.imports) {
    if (from !== path && targets.includes(path)) dependents.push(from);
  }
  dependents.sort(byPath);
  return {
    result: {
      path: building.path,
      zoneId: building.zoneId,
      band: building.band,
      lines: building.lines,
      bytes: building.bytes,
      parse: building.parse,
      imports: [...(model.imports.get(path) ?? [])].sort(byPath),
      unresolvedImportCount: model.unresolved.get(path) ?? 0,
      dependents,
      recentChanges: recentChangesFor(model.events, path),
      testState: testStateFor(model.events, path),
      notes: model.notes
        .filter((n) => n.path === path)
        .map((n) => ({ note: n.note, ts: n.ts, ...(n.agentId !== undefined ? { agentId: n.agentId } : {}) })),
    },
  };
}

export type TraceResult = { path: string; markdown: string };

/**
 * Assemble one file's structural trace export: the same markdown
 * the inspector "Copy trace" button copies, built by the single
 * server formatter. Read-only over the model (no writes, no
 * events); unknown paths reuse the getBuilding error.
 */
export function getTrace(model: QueryModel, path: string): { result: TraceResult } | { error: QueryError } {
  const building = model.buildings.find((b) => b.path === path);
  if (!building) return { error: { code: "unknown-building", message: `unknown building: ${path}` } };
  // Own imports are unproven — never an empty claim of zero
  // imports — when the file is binary or its parse never produced
  // facts. (A parsed-but-unmatched language lists `none`, the
  // getBuilding precedent: its imports resolved to nothing.)
  const lined = model.importLines.get(path) ?? [];
  const linedTargets = new Set(lined.map((e) => e.target));
  // Belt edges with no statement line (JVM type uses resolved
  // through the same package or a wildcard import) are still proven
  // facts: list them unlined rather than printing a false `none`
  // while the belts show edges (NFR3).
  const unlined = [...(model.imports.get(path) ?? [])]
    .filter((t) => !linedTargets.has(t))
    .map((target): TraceImportEntry => ({ target, line: null }));
  const imports: TraceInput["imports"] = building.binary
    ? { unproven: "binary" }
    : building.parse === "error"
      ? { unproven: "parse-error" }
      : building.parse === "unparsed"
        ? { unproven: "unparsed" }
        : [...lined.map((e) => ({ target: e.target, line: e.line })), ...unlined];
  // Dependents invert the same line map: every importer contributes
  // its own statement line. One linear pass per request, the
  // getBuilding precedent — no stored index to keep consistent.
  // Importers proven only through type use contribute unlined rows.
  const importedBy: TraceInput["importedBy"] = [];
  const linedDependents = new Set<string>();
  for (const [from, entries] of model.importLines) {
    if (from === path) continue;
    for (const e of entries) {
      if (e.target === path) {
        importedBy.push({ path: from, line: e.line });
        linedDependents.add(from);
      }
    }
  }
  for (const [from, targets] of model.imports) {
    if (from === path || linedDependents.has(from)) continue;
    if (targets.includes(path)) importedBy.push({ path: from, line: null });
  }
  const conn = model.conns.get(path);
  const markdown = formatTrace({
    path,
    repo: model.repo,
    imports,
    importedBy,
    endpoints: (conn?.endpoints ?? []).map((ep) => ({
      method: ep.method,
      route: ep.path,
      line: ep.line,
      handler: ep.handler,
      tables: ep.tables.map((t) => ({ table: t.table, access: t.access })),
      callers: ep.callers.map((c) => ({ path: c.path, line: c.line, caller: c.caller, via: c.via })),
    })),
    callsOut: (conn?.calls ?? []).map((c) => ({
      method: c.method,
      path: c.path,
      line: c.line,
      via: c.via,
      caller: c.caller,
      ...(c.matchedPath !== undefined ? { matchedPath: c.matchedPath } : {}),
      ...(c.targetService !== undefined ? { targetService: c.targetService } : {}),
    })),
    // Direct tables only, assembled from the file's own facts
    // before transitive merging: the summary's merged rows cannot
    // discriminate (a direct read + injected write merges to
    // readwrite under the file's own `through`).
    tables: [...(model.directTables.get(path) ?? [])]
      .map((t) => ({ table: t.table, access: t.access, via: t.via, through: t.through, implicit: t.derived === "implicit-name" })),
    topics: (conn?.topics ?? []).map((t) => ({ topic: t.topic, direction: t.direction, handler: t.handler, peers: [...t.peers] })),
    unresolvedImports: model.unresolved.get(path) ?? 0,
    unresolvedDynamics: conn?.unresolvedNotes ?? 0,
  });
  return { result: { path, markdown } };
}

export function getPlan(model: QueryModel): {
  agent: AgentStatus;
  ghosts: { path: string; state: GhostBuilding["state"]; step?: string }[];
  runs: readonly RunRecord[];
} {
  return {
    agent: model.agent,
    ghosts: model.ghosts.map((g) => ({ path: g.path, state: g.state, ...(g.step !== undefined ? { step: g.step } : {}) })),
    runs: model.runs,
  };
}

export function getDbSchema(model: QueryModel): DbSchema {
  const tables = new Map<string, { path: string; access: string; via: string }[]>();
  const endpoints: DbSchema["endpoints"] = [];
  for (const [path, conn] of model.conns) {
    for (const t of conn.tables) {
      const users = tables.get(t.table) ?? [];
      users.push({ path, access: t.access, via: t.via });
      tables.set(t.table, users);
    }
    for (const ep of conn.endpoints) {
      endpoints.push({ path, method: ep.method, route: ep.path, line: ep.line, tables: ep.tables.map((t) => t.table) });
    }
  }
  return {
    tables: [...tables.entries()]
      .map(([table, usedBy]) => ({ table, usedBy: usedBy.sort((a, b) => byPath(a.path, b.path)) }))
      .sort((a, b) => byPath(a.table, b.table)),
    endpoints: endpoints.sort((a, b) => byPath(a.path, b.path) || a.line - b.line),
    schemaZoneBuilt: false,
  };
}

export type PreparedNote = { note: string; masked: boolean };

/**
 * Validate + secret-mask a raw annotate note. Pure: the server
 * persists the returned note. Trimmed (a whitespace-only note is
 * an empty note); masked before the length check, since masking
 * replaces values with a fixed token.
 */
export function prepareNote(raw: string): { prepared: PreparedNote } | { error: QueryError } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: { code: "empty-note", message: "note must be non-empty" } };
  const { content, masked } = maskContent(trimmed);
  if (content.length > MAX_TEXT_CHARS) {
    return { error: { code: "note-too-long", message: `note exceeds ${MAX_TEXT_CHARS} chars` } };
  }
  return { prepared: { note: content, masked } };
}
