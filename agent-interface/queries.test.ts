import { describe, expect, test } from "bun:test";
import type { BuildingConnections } from "../connections/graph.ts";
import { MAX_TEXT_CHARS, validateFloorEvent, type FloorEvent } from "../events/index.ts";
import type { AgentNote, Building } from "../floor-ui/wire.ts";
import {
  getBuilding,
  getDbSchema,
  getPlan,
  getTrace,
  listBuildings,
  prepareNote,
  RECENT_CHANGES_MAX,
  type QueryModel,
} from "./queries.ts";

function building(path: string, over: Partial<Building> = {}): Building {
  return {
    id: `b-${path}`,
    path,
    zoneId: "src",
    x: 0,
    y: 0,
    band: 0,
    lines: 10,
    bytes: 100,
    mtimeMs: 0,
    binary: false,
    parse: "ok",
    unresolvedCount: 0,
    ...over,
  };
}

function event(over: Record<string, unknown>): FloorEvent {
  return validateFloorEvent({ v: 1, id: `e-${Math.random()}`, ts: 1_700_000_000_000, agentId: "watcher", ...over });
}

function model(over: Partial<QueryModel> = {}): QueryModel {
  return {
    repo: "",
    buildings: [],
    imports: new Map(),
    importLines: new Map(),
    directTables: new Map(),
    unresolved: new Map(),
    events: [],
    notes: [],
    ghosts: [],
    agent: { agentId: "muse", state: "idle" },
    runs: [],
    conns: new Map(),
    ...over,
  };
}

function conn(over: Partial<BuildingConnections> = {}): BuildingConnections {
  return { repo: "", kinds: [], endpoints: [], tables: [], calls: [], topics: [], unresolvedNotes: 0, ...over };
}

describe("listBuildings", () => {
  test("lists summaries sorted by path with a truthful total", () => {
    // Value: protects=agent's what-exists view; fails_when=shape drifts or order is unstable
    const m = model({
      buildings: [building("src/b.ts", { lines: 5 }), building("src/a.ts", { band: 2, parse: "error" })],
    });
    expect(listBuildings(m)).toEqual({
      total: 2,
      buildings: [
        { path: "src/a.ts", zoneId: "src", band: 2, lines: 10, parse: "error" },
        { path: "src/b.ts", zoneId: "src", band: 0, lines: 5, parse: "ok" },
      ],
    });
  });

  test("empty floor is an honest empty, not an error", () => {
    // Value: protects=missing-shown-as-missing on empty floors; fails_when=empty throws or lies about total
    expect(listBuildings(model())).toEqual({ total: 0, buildings: [] });
  });
});

describe("getBuilding", () => {
  const base = () =>
    model({
      buildings: [building("src/a.ts"), building("src/b.ts", { unresolvedCount: 3 })],
      imports: new Map([
        ["src/a.ts", ["src/b.ts"]],
        ["src/b.ts", []],
      ]),
      unresolved: new Map([["src/b.ts", 3]]),
    });

  test("returns the full neighborhood record", () => {
    // Value: protects=agent's per-file context (imports/dependents/counts); fails_when=mapping drifts
    const m = base();
    const got = getBuilding(m, "src/b.ts");
    expect("error" in got ? got.error : null).toBeNull();
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result).toMatchObject({
      path: "src/b.ts",
      imports: [],
      unresolvedImportCount: 3,
      dependents: ["src/a.ts"],
      testState: { status: "unknown" },
      notes: [],
    });
  });

  test("unknown path is an explicit error naming the path", () => {
    // Value: protects=no silent gaps on typos; fails_when=unknown returns empty instead of an error
    const got = getBuilding(base(), "src/nope.ts");
    expect(got).toEqual({ error: { code: "unknown-building", message: "unknown building: src/nope.ts" } });
  });

  test("recent changes cap at 10, newest first, renames carry fromPath", () => {
    // Value: protects=bounded what-changed answers; fails_when=cap/order/rename evidence regresses
    const events: FloorEvent[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(
        event({ type: "observed-change", provenance: "observed", path: "src/a.ts", change: "modified", ts: 100 + i }),
      );
    }
    events.push(
      event({ type: "file-written", provenance: "observed", path: "src/a.ts", ts: 200 }),
      event({ type: "observed-change", provenance: "observed", path: "src/a.ts", change: "renamed", fromPath: "src/old.ts", ts: 201 }),
      event({ type: "observed-change", provenance: "observed", path: "src/other.ts", change: "modified", ts: 999 }),
    );
    const got = getBuilding(model({ buildings: [building("src/a.ts")], events }), "src/a.ts");
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result.recentChanges.length).toBe(RECENT_CHANGES_MAX);
    expect(got.result.recentChanges[0]).toEqual({ ts: 201, kind: "renamed", fromPath: "src/old.ts" });
    expect(got.result.recentChanges[1]).toEqual({ ts: 200, kind: "written" });
    expect(got.result.recentChanges.map((c) => c.ts)).toEqual([...got.result.recentChanges.map((c) => c.ts)].sort((a, b) => b - a));
  });

  test("testState derives newest-first and never attributes unscoped results", () => {
    // Value: protects=honest test state; fails_when=stale wins or an unscoped run attaches to a file
    const events: FloorEvent[] = [
      event({ type: "test-result", provenance: "observed", path: "src/a.ts", passed: 3, failed: 1, ts: 100 }),
      event({ type: "test-result", provenance: "observed", path: "src/a.ts", passed: 5, failed: 0, command: "bun test", ts: 101 }),
      event({ type: "test-result", provenance: "observed", passed: 99, failed: 0, ts: 102 }),
    ];
    const got = getBuilding(model({ buildings: [building("src/a.ts"), building("src/b.ts")], events }), "src/a.ts");
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result.testState).toEqual({ status: "pass", passed: 5, failed: 0, command: "bun test", ts: 101 });
    const other = getBuilding(model({ buildings: [building("src/b.ts")], events }), "src/b.ts");
    if (!("result" in other)) throw new Error("expected result");
    expect(other.result.testState).toEqual({ status: "unknown" });
  });

  test("testState fails when the latest result has failures", () => {
    // Value: protects=fail visibility for agents; fails_when=failed>0 still reports pass
    const events: FloorEvent[] = [
      event({ type: "test-result", provenance: "observed", path: "src/a.ts", passed: 5, failed: 0, ts: 100 }),
      event({ type: "test-result", provenance: "observed", path: "src/a.ts", passed: 4, failed: 2, ts: 101 }),
    ];
    const got = getBuilding(model({ buildings: [building("src/a.ts")], events }), "src/a.ts");
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result.testState).toEqual({ status: "fail", passed: 4, failed: 2, ts: 101 });
  });

  test("notes pass through scoped to the path, oldest first", () => {
    // Value: protects=annotate read-back; fails_when=notes leak across buildings or reorder
    const notes: AgentNote[] = [
      { path: "src/a.ts", note: "first", ts: 100, agentId: "muse" },
      { path: "src/b.ts", note: "elsewhere", ts: 101 },
      { path: "src/a.ts", note: "second", ts: 102 },
    ];
    const got = getBuilding(model({ buildings: [building("src/a.ts")], notes }), "src/a.ts");
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result.notes).toEqual([
      { note: "first", ts: 100, agentId: "muse" },
      { note: "second", ts: 102 },
    ]);
  });
});

describe("getTrace", () => {
  test("unknown path is an explicit error naming the path", () => {
    // Value: protects=no silent gaps on typos; fails_when=unknown returns markdown instead of an error
    const got = getTrace(model({ buildings: [building("src/a.ts")] }), "src/nope.ts");
    expect(got).toEqual({ error: { code: "unknown-building", message: "unknown building: src/nope.ts" } });
  });

  test("assembles imports and dependents with statement lines", () => {
    // Value: protects=trace anchors (own lines + inverted dependents);
    // fails_when=inversion drops lines or misattributes them
    const m = model({
      repo: "shop",
      buildings: [building("src/a.ts"), building("src/b.ts"), building("src/c.ts")],
      importLines: new Map([
        ["src/a.ts", [{ target: "src/b.ts", line: 3 }, { target: "src/c.ts", line: 9 }]],
        ["src/b.ts", [{ target: "src/a.ts", line: 2 }]],
        ["src/c.ts", []],
      ]),
    });
    const got = getTrace(m, "src/a.ts");
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result.path).toBe("src/a.ts");
    expect(got.result.markdown).toContain("# trace: src/a.ts\nfloor: shop\n");
    expect(got.result.markdown).toContain("## imports (2)\n- src/b.ts:3\n- src/c.ts:9\n");
    expect(got.result.markdown).toContain("## imported by (1)\n- src/b.ts:2\n");
  });

  test("empty maps and self-imports yield honest empty sections", () => {
    // Value: protects=inversion over missing keys + self exclusion;
    // fails_when=a missing key throws or a self-edge lists as a dependent
    const m = model({
      buildings: [building("src/a.ts")],
      importLines: new Map([["src/a.ts", [{ target: "src/a.ts", line: 1 }]]]),
    });
    const got = getTrace(m, "src/a.ts");
    if (!("result" in got)) throw new Error("expected result");
    expect(got.result.markdown).toContain("## imports (1)\n- src/a.ts:1\n");
    expect(got.result.markdown).toContain("## imported by (0)\nnone\n");
    const bare = getTrace(model({ buildings: [building("src/a.ts")] }), "src/a.ts");
    if (!("result" in bare)) throw new Error("expected result");
    expect(bare.result.markdown).toContain("## imports (0)\nnone\n");
  });

  test("unparsed, error, and binary files export unproven own-imports with true dependents", () => {
    // Value: protects=FR3 honesty (dependents are proven by other
    // files' facts even when own imports are not); fails_when=an
    // unparsed file claims zero imports or loses its dependents
    const cases = [
      { over: { parse: "unparsed" as const }, reason: "unparsed" },
      { over: { parse: "error" as const }, reason: "parse-error" },
      { over: { binary: true }, reason: "binary" },
    ];
    for (const { over, reason } of cases) {
      const m = model({
        buildings: [building("src/a.ts", over), building("src/b.ts")],
        importLines: new Map([["src/b.ts", [{ target: "src/a.ts", line: 4 }]]]),
      });
      const got = getTrace(m, "src/a.ts");
      if (!("result" in got)) throw new Error("expected result");
      expect(got.result.markdown).toContain(`## imports (?)\nunproven (${reason})\n`);
      expect(got.result.markdown).toContain("## imported by (1)\n- src/b.ts:4\n");
    }
  });

  test("unlined type-use edges list honestly instead of a false none", () => {
    // Value: protects=F1 (belt edges with no statement line —
    // wildcard/same-package JVM uses — still render); fails_when=a
    // fully-unlined file claims none while belts show edges
    const m = model({
      buildings: [building("shop/A.java"), building("shop/B.java"), building("shop/C.java")],
      imports: new Map([
        ["shop/A.java", ["shop/B.java", "shop/C.java"]],
        ["shop/B.java", ["shop/A.java"]],
        ["shop/C.java", []],
      ]),
      importLines: new Map([
        ["shop/A.java", [{ target: "shop/B.java", line: 3 }]],
        ["shop/B.java", []],
        ["shop/C.java", [{ target: "shop/A.java", line: 7 }]],
      ]),
    });
    const got = getTrace(m, "shop/A.java");
    if (!("result" in got)) throw new Error("expected result");
    // C is a proven belt edge with no statement line: named, counted.
    expect(got.result.markdown).toContain("## imports (2)\n- shop/B.java:3\n- shop/C.java (type use, no import line)\n");
    // B imports A only through type use; C cites a statement line.
    expect(got.result.markdown).toContain("## imported by (2)\n- shop/B.java (type use, no import line)\n- shop/C.java:7\n");
    // A file whose every edge is unlined never prints a bare none.
    const bare = getTrace(m, "shop/B.java");
    if (!("result" in bare)) throw new Error("expected result");
    expect(bare.result.markdown).toContain("## imports (1)\n- shop/A.java (type use, no import line)\n");
  });

  test("maps connections: endpoints, calls, direct tables, topics, and counts", () => {
    // Value: protects=trace connection assembly (direct-only
    // tables, caller/dest honesty, unresolved counts);
    // fails_when=transitive tables leak in or a dest guesses
    const m = model({
      buildings: [building("src/api.ts")],
      unresolved: new Map([["src/api.ts", 2]]),
      directTables: new Map([
        ["src/api.ts", [{ table: "xs", access: "read", via: "repository", derived: "explicit", through: "Api" }]],
      ]),
      conns: new Map([
        ["src/api.ts", conn({
          className: "Api",
          endpoints: [{
            method: "GET",
            path: "/x",
            handler: "getX",
            line: 10,
            tables: [{ table: "xs", access: "read", via: "repository", derived: "explicit", through: "Api.getX" }],
            callers: [{ path: "web/ui.ts", caller: "load", via: "fetch", line: 3 }],
          }],
          tables: [
            { table: "xs", access: "readwrite", via: "repository", derived: "explicit", through: "Api" },
            { table: "far", access: "read", via: "entity", derived: "explicit", through: "Other.list" },
          ],
          calls: [
            { method: "POST", path: "/save", via: "feign", caller: "save", line: 20, targetService: "svc", matchedPath: "svc:api.ts" },
            { method: "GET", path: "/gone", via: "fetch", caller: "", line: 21 },
          ],
          topics: [{ topic: "events", direction: "consume", handler: "onEvent", line: 30, peers: ["svc:worker.ts"] }],
          unresolvedNotes: 1,
        })],
      ]),
    });
    const got = getTrace(m, "src/api.ts");
    if (!("result" in got)) throw new Error("expected result");
    const md = got.result.markdown;
    expect(md).toContain("- GET /x src/api.ts:10 → getX → tables: xs (read)\n  ← web/ui.ts:3 load (fetch)\n");
    expect(md).toContain("- POST /save src/api.ts:20 (feign, save) → svc:api.ts\n");
    expect(md).toContain("- GET /gone src/api.ts:21 (fetch) → unresolved\n");
    expect(md).toContain("- xs read via repository through Api\n");
    // The merged closure's readwrite (direct read + injected write)
    // must not leak into the direct-only section.
    expect(md).not.toContain("readwrite");
    expect(md).not.toContain("far read");
    expect(md).toContain("- events consume (onEvent) · peers: svc:worker.ts\n");
    expect(md).toContain("## unresolved\n2 unresolved import(s)\n1 dynamic connection(s) not guessed\n");
  });
});

describe("getPlan", () => {
  test("returns worker status, ghosts, and runs as-is", () => {
    // Value: protects=agent's what-is-planned view; fails_when=ghost evidence (step) is dropped
    const m = model({
      agent: { agentId: "muse", state: "working", step: "add index" },
      ghosts: [{ path: "src/new.ts", zoneId: "src", x: 0, y: 0, state: "planned", step: "create new.ts" }],
      runs: [{ id: "p1", sessionId: "s1", prompt: "do it", startedAt: 1, state: "running" }],
    });
    expect(getPlan(m)).toEqual({
      agent: { agentId: "muse", state: "working", step: "add index" },
      ghosts: [{ path: "src/new.ts", state: "planned", step: "create new.ts" }],
      runs: [{ id: "p1", sessionId: "s1", prompt: "do it", startedAt: 1, state: "running" }],
    });
  });
});

describe("getDbSchema", () => {
  test("aggregates tables and endpoints, flagging the zone as unbuilt", () => {
    // Value: protects=reachability answers with honest scope; fails_when=aggregation drops users or the flag flips
    const m = model({
      conns: new Map([
        ["src/a.ts", conn({
          tables: [{ table: "users", access: "read", via: "repository", derived: "explicit", through: "A.list" }],
          endpoints: [{ method: "GET", path: "/users", handler: "A.list", line: 10, tables: [], callers: [] }],
        })],
        ["src/b.ts", conn({
          tables: [{ table: "users", access: "write", via: "repository", derived: "explicit", through: "B.save" }],
          endpoints: [],
        })],
      ]),
    });
    expect(getDbSchema(m)).toEqual({
      tables: [{ table: "users", usedBy: [{ path: "src/a.ts", access: "read", via: "repository" }, { path: "src/b.ts", access: "write", via: "repository" }] }],
      endpoints: [{ path: "src/a.ts", method: "GET", route: "/users", line: 10, tables: [] }],
      schemaZoneBuilt: false,
    });
  });

  test("no connections is an honest empty", () => {
    // Value: protects=missing-shown-as-missing for schema; fails_when=empty errors or fabricates tables
    expect(getDbSchema(model())).toEqual({ tables: [], endpoints: [], schemaZoneBuilt: false });
  });
});

describe("prepareNote", () => {
  test("accepts a plain note unchanged and unmasked", () => {
    // Value: protects=annotate happy path; fails_when=plain text is altered or flagged
    expect(prepareNote("why: the index was missing")).toEqual({ prepared: { note: "why: the index was missing", masked: false } });
  });

  test("empty and whitespace-only notes are explicit errors", () => {
    // Value: protects=no silent empty notes; fails_when=blank text stores
    expect(prepareNote("")).toEqual({ error: { code: "empty-note", message: "note must be non-empty" } });
    expect(prepareNote("  \n\t ")).toEqual({ error: { code: "empty-note", message: "note must be non-empty" } });
  });

  test("secrets are masked before length is judged", () => {
    // Value: protects=D18 masking at emit; fails_when=a key assignment survives into the stored note
    const got = prepareNote('why: rotated\nconst API_KEY = "sk-live-123"');
    if (!("prepared" in got)) throw new Error("expected prepared");
    expect(got.prepared.note).toBe("why: rotated\nconst API_KEY = [masked]");
    expect(got.prepared.masked).toBe(true);
  });

  test("notes past the char bound are rejected, not truncated", () => {
    // Value: protects=explicit refusal over silent truncation; fails_when=oversize stores or clips quietly
    const tooLong = `x: ${"n".repeat(MAX_TEXT_CHARS)}`;
    expect(prepareNote(tooLong)).toEqual({ error: { code: "note-too-long", message: `note exceeds ${MAX_TEXT_CHARS} chars` } });
    const edge = "n".repeat(MAX_TEXT_CHARS);
    const ok = prepareNote(edge);
    if (!("prepared" in ok)) throw new Error("expected prepared");
    expect(ok.prepared.note.length).toBe(MAX_TEXT_CHARS);
  });
});
