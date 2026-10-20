import { describe, expect, test } from "bun:test";
import type { QueryModel } from "./queries.ts";
import { AGENT_ERRORS, handleAgentRequest, MAX_AGENT_BODY_BYTES, type TokenStore } from "./protocol.ts";

function emptyModel(): QueryModel {
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
  };
}

function store(over: Partial<TokenStore> = {}): TokenStore {
  return {
    token: "launch-token",
    model: () => emptyModel(),
    annotate: () => ({ ts: 1_700_000_000_111 }),
    ...over,
  };
}

const AUTH = "Bearer launch-token";

function call(s: TokenStore, body: string, auth: string | null = AUTH) {
  const res = handleAgentRequest(s, auth, body);
  return { ...res, json: JSON.parse(res.body) as { v: number; id: unknown; result?: unknown; error?: { code: number; message: string } } };
}

function rpc(method: unknown, params?: unknown, id: unknown = 7) {
  return JSON.stringify(params === undefined ? { method, id } : { method, params, id });
}

describe("agent protocol", () => {
  test("listBuildings happy path echoes id with version 1", () => {
    // Value: protects=envelope contract; fails_when=id/version/echo drifts
    const got = call(store(), rpc("floor.listBuildings", {}, "abc"));
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ v: 1, id: "abc", result: { total: 0, buildings: [] } });
  });

  test("missing id echoes null", () => {
    // Value: protects=id-less clients; fails_when=id echoes undefined (dropped key)
    const got = call(store(), JSON.stringify({ method: "floor.getPlan" }));
    expect(got.json.id).toBeNull();
    expect(got.json.result).toMatchObject({ agent: { agentId: "muse", state: "idle" } });
  });

  test("missing, malformed, and forged auth all fail closed with 401", () => {
    // Value: protects=launch-token gate; fails_when=any non-token shape authenticates
    for (const auth of [null, "", "launch-token", "Bearer wrong", "bearer launch-token", "Bearer launch-token "] as const) {
      const got = call(store(), rpc("floor.listBuildings"), auth);
      expect(got.status).toBe(401);
      expect(got.json.error?.code).toBe(AGENT_ERRORS.badAuth);
    }
  });

  test("non-JSON body is a 400 with a null id", () => {
    // Value: protects=explicit transport errors; fails_when=garbage throws or echoes a phantom id
    const got = call(store(), "{nope");
    expect(got.status).toBe(400);
    expect(got.json).toMatchObject({ id: null, error: { code: AGENT_ERRORS.invalidParams } });
  });

  test("non-object JSON and oversize bodies are rejected", () => {
    // Value: protects=parser + memory bounds; fails_when=array/null/oversize reaches dispatch
    for (const body of ["[1]", "null", '"str"']) {
      expect(call(store(), body).status).toBe(400);
    }
    const big = `{"method":"floor.listBuildings","pad":"${"x".repeat(MAX_AGENT_BODY_BYTES)}"}`;
    const got = call(store(), big);
    expect(got.status).toBe(413);
    expect(got.json.error?.code).toBe(AGENT_ERRORS.invalidParams);
  });

  test("unknown method names itself in a -32601", () => {
    // Value: protects=no silent no-ops on typos; fails_when=unknown methods succeed or miscode
    const got = call(store(), rpc("floor.deleteEverything"));
    expect(got.status).toBe(200);
    expect(got.json.error).toEqual({ code: AGENT_ERRORS.methodNotFound, message: "unknown method: floor.deleteEverything" });
  });

  test("non-object params are invalid", () => {
    // Value: protects=param-shape gate; fails_when=array params reach a method
    const got = call(store(), rpc("floor.listBuildings", [1]));
    expect(got.json.error?.code).toBe(AGENT_ERRORS.invalidParams);
  });

  test("getBuilding requires a non-empty path and maps unknown buildings", () => {
    // Value: protects=explicit per-method validation; fails_when=missing path dispatches or miscodes
    expect(call(store(), rpc("floor.getBuilding", {})).json.error?.code).toBe(AGENT_ERRORS.invalidParams);
    expect(call(store(), rpc("floor.getBuilding", { path: "" })).json.error?.code).toBe(AGENT_ERRORS.invalidParams);
    const got = call(store(), rpc("floor.getBuilding", { path: "src/nope.ts" }));
    expect(got.json.error).toEqual({ code: AGENT_ERRORS.invalidParams, message: "unknown building: src/nope.ts" });
  });

  test("annotate validates building, note, and agent shapes", () => {
    // Value: protects=annotate input gate; fails_when=bad shapes reach the store
    const cases: unknown[] = [
      {},
      { building: "", note: "x" },
      { building: "src/a.ts" },
      { building: "src/a.ts", note: 42 },
      { building: "src/a.ts", note: "x", agent: "" },
    ];
    for (const params of cases) {
      expect(call(store(), rpc("floor.annotate", params)).json.error?.code).toBe(AGENT_ERRORS.invalidParams);
    }
  });

  test("annotate maps prepareNote errors and returns path/ts/masked", () => {
    // Value: protects=annotate result contract; fails_when=empty-note succeeds or masked flag drops
    expect(call(store(), rpc("floor.annotate", { building: "src/a.ts", note: "  " })).json.error?.message).toBe("note must be non-empty");
    const seen: unknown[] = [];
    const s = store({ annotate: (path, note, agentId) => { seen.push([path, note, agentId]); return { ts: 4242 }; } });
    const got = call(s, rpc("floor.annotate", { building: "src/a.ts", note: "why", agent: "muse" }));
    expect(got.json.result).toEqual({ path: "src/a.ts", ts: 4242, masked: false });
    expect(seen).toEqual([["src/a.ts", "why", "muse"]]);
  });

  test("annotate maps store errors (un-annotatable paths) to invalid params", () => {
    // Value: protects=explicit failure when the event layer refuses a path; fails_when=store errors throw or succeed
    const s = store({ annotate: () => ({ error: "field \"path\" must be a repo-relative POSIX path" }) });
    const got = call(s, rpc("floor.annotate", { building: "we\\ird.ts", note: "x" }));
    expect(got.json.error).toEqual({ code: AGENT_ERRORS.invalidParams, message: "field \"path\" must be a repo-relative POSIX path" });
  });

  test("getDbSchema passes the model result through", () => {
    // Value: protects=schema result plumbing; fails_when=dispatch alters the query result
    const got = call(store(), rpc("floor.getDbSchema"));
    expect(got.json.result).toEqual({ tables: [], endpoints: [], schemaZoneBuilt: false });
  });

  test("getTrace requires a non-empty path and maps unknown buildings", () => {
    // Value: protects=explicit per-method validation; fails_when=missing path dispatches or miscodes
    expect(call(store(), rpc("floor.getTrace", {})).json.error).toEqual({ code: AGENT_ERRORS.invalidParams, message: "getTrace requires a non-empty path" });
    expect(call(store(), rpc("floor.getTrace", { path: "" })).json.error?.code).toBe(AGENT_ERRORS.invalidParams);
    expect(call(store(), rpc("floor.getTrace", { path: 42 })).json.error?.code).toBe(AGENT_ERRORS.invalidParams);
    const got = call(store(), rpc("floor.getTrace", { path: "src/nope.ts" }));
    expect(got.json.error).toEqual({ code: AGENT_ERRORS.invalidParams, message: "unknown building: src/nope.ts" });
  });

  test("getTrace returns path+markdown and writes nothing", () => {
    // Value: protects=trace result contract + read-only (no store
    // writes through the dispatch path); fails_when=the shape
    // drifts or a read annotates
    const annotated: unknown[] = [];
    const s = store({
      model: () => ({
        ...emptyModel(),
        repo: "shop",
        buildings: [{
          id: "b1", path: "src/a.ts", zoneId: "src", x: 0, y: 0, band: 0 as const,
          lines: 10, bytes: 100, mtimeMs: 0, binary: false, parse: "ok" as const, unresolvedCount: 0,
        }],
      }),
      annotate: (...args: unknown[]) => { annotated.push(args); return { ts: 1 }; },
    });
    const got = call(s, rpc("floor.getTrace", { path: "src/a.ts" }));
    expect(got.status).toBe(200);
    expect(got.json.result).toMatchObject({ path: "src/a.ts" });
    expect(String((got.json.result as { markdown: string }).markdown)).toContain("# trace: src/a.ts\nfloor: shop\n");
    expect(annotated).toEqual([]);
  });
});
