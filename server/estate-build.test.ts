import { describe, expect, test } from "bun:test";
import {
  bandForTraffic,
  buildEstateFloor,
  isBigBox,
  isExposed,
  parseBoxEndpointId,
  parseGatewayRoutes,
  shortRepo,
  type BoxJson,
  type EstateFileEntry,
  type EstateJson,
  type FrontendJson,
} from "./estate-build.ts";
import type { EndpointSummary } from "../connections/graph.ts";

const FAT = "UM.tesoreria.core-service";
const THIN = "UM.tesoreria.sender-service";
const ROUTES = [
  { id: "tesoreria-core-service", service: "tesoreria-core-service", path: "/api/tesoreria/core" },
  { id: "tesoreria-sender-service", service: "tesoreria-sender-service", path: "/api/tesoreria/sender" },
];

function ep(method: string, path: string, tables: EndpointSummary["tables"], handler = "h", line = 1): EndpointSummary {
  return { method, path, handler, line, tables, callers: [] };
}

function table(name: string, access: "read" | "write" | "readwrite" | "unknown" = "read") {
  return { table: name, access, via: "repository" as const, derived: "explicit" as const, through: `C.${name}` };
}

function entry(over: Partial<EstateFileEntry> & { repo: string }): EstateFileEntry {
  return {
    kinds: [],
    endpoints: [],
    tables: [],
    calls: [],
    topics: [],
    unresolvedNotes: 0,
    ...over,
  };
}

/** 10 entity files make FAT a table owner (the bar is 10). */
function entityFiles(): Record<string, EstateFileEntry> {
  const out: Record<string, EstateFileEntry> = {};
  for (let i = 0; i < 10; i++) {
    out[`${FAT}\0src/E${i}.java`] = entry({ repo: FAT, kinds: ["entity"], className: `E${i}` });
  }
  return out;
}

function box(over: Partial<BoxJson> & { id: string }): BoxJson {
  return {
    name: over.id,
    tables: [],
    tableCount: 0,
    endpointCount: 0,
    fileCount: 0,
    repos: [],
    writes: [],
    seeded: [],
    endpoints: [],
    files: [],
    consumers: [],
    ...over,
  };
}

describe("parseBoxEndpointId", () => {
  test("splits repo, file, method, path", () => {
    expect(parseBoxEndpointId("R:src/A.java:GET /x/{id}")).toEqual({ repo: "R", file: "src/A.java", method: "GET", path: "/x/{id}" });
  });
  test("rejects shapeless ids", () => {
    expect(parseBoxEndpointId("no-colons")).toBeUndefined();
    expect(parseBoxEndpointId("R:only-one")).toBeUndefined();
    expect(parseBoxEndpointId("R:f:no-space-here")).toBeUndefined();
    expect(parseBoxEndpointId(":f:GET /x")).toBeUndefined();
  });
});

describe("shortRepo", () => {
  test("strips area and -service", () => {
    expect(shortRepo("UM.tesoreria.sender-service")).toBe("t-sender");
    expect(shortRepo("UM.haberes.core-service")).toBe("h-core");
    expect(shortRepo("UM.tesoreria.compras-service.upstream")).toBe("t-compras.upstream");
    expect(shortRepo("UM.tesoreria.gateway-service")).toBe("t-gateway");
    expect(shortRepo("something-else")).toBe("something-else");
  });
});

describe("bandForTraffic", () => {
  test("thresholds", () => {
    expect(bandForTraffic(0)).toBe(0);
    expect(bandForTraffic(4)).toBe(0);
    expect(bandForTraffic(5)).toBe(1);
    expect(bandForTraffic(19)).toBe(1);
    expect(bandForTraffic(20)).toBe(2);
    expect(bandForTraffic(59)).toBe(2);
    expect(bandForTraffic(60)).toBe(3);
  });
});

describe("isBigBox", () => {
  test("two tables or ten endpoints", () => {
    expect(isBigBox(box({ id: "a", tableCount: 2, endpointCount: 1 }))).toBe(true);
    expect(isBigBox(box({ id: "a", tableCount: 1, endpointCount: 10 }))).toBe(true);
    expect(isBigBox(box({ id: "a", tableCount: 1, endpointCount: 9 }))).toBe(false);
  });
});

function fixture(): { estate: EstateJson; boxes: { boxes: BoxJson[]; unboxed: string[] } } {
  const fatCtl = "src/Ctl.java";
  const fatClient = "src/Client.java";
  const thinCtl = "src/T.java";
  const eps = [
    ep("GET", "/a", [table("t1", "read")], "a", 10),
    ep("POST", "/b", [table("t1", "write"), table("t2", "read")], "b", 20),
  ];
  const estate: EstateJson = {
    repos: [{ repo: FAT }, { repo: THIN }],
    byFile: {
      ...entityFiles(),
      [`${FAT}\0${fatCtl}`]: entry({ repo: FAT, kinds: ["controller"], className: "Ctl", endpoints: eps }),
      [`${FAT}\0${fatClient}`]: entry({
        repo: FAT, kinds: ["feign"], className: "Client",
        calls: [{ method: "GET", path: "/t", via: "feign", caller: "Client.go", line: 5, matchedPath: `${THIN}:${thinCtl}` }],
      }),
      [`${THIN}\0${thinCtl}`]: entry({ repo: THIN, kinds: ["controller"], className: "T", endpoints: [ep("GET", "/t", [table("t3")], "t", 7)] }),
      [`${FAT}\0src/Plain.java`]: entry({ repo: FAT, kinds: ["component"], className: "Plain" }),
    },
  };
  const boxes = {
    boxes: [
      box({
        id: "box-01", name: "alpha", tables: ["t1", "t2", "t9"], tableCount: 3, endpointCount: 2, fileCount: 1,
        repos: [FAT], files: [`${FAT}:${fatCtl}`],
        endpoints: [`${FAT}:${fatCtl}:GET /a`, `${FAT}:${fatCtl}:POST /b`, `${FAT}:${fatCtl}:GET /missing`],
      }),
    ],
    unboxed: ["orphan-table"],
  };
  return { estate, boxes };
}

describe("buildEstateFloor", () => {
  test("fails fast on shapeless inputs", () => {
    expect(() => buildEstateFloor(undefined as unknown as EstateJson, { boxes: [], unboxed: [] }, [])).toThrow("missing byFile");
    expect(() => buildEstateFloor({ repos: [], byFile: {} }, undefined as unknown as { boxes: BoxJson[]; unboxed: string[] }, [])).toThrow("missing boxes");
  });

  test("box machine carries its own tables with merged access", () => {
    const { estate, boxes } = fixture();
    const f = buildEstateFloor(estate, boxes, ROUTES);
    const b = f.buildings.find((x) => x.id === "box-01")!;
    expect(b.path).toBe("core/box-01-alpha");
    expect(b.conn!.tables.map((t) => `${t.table}:${t.access}`).sort()).toEqual(["t1:readwrite", "t2:read", "t9:unknown"]);
    expect(b.conn!.kinds).toEqual(["box"]);
    expect(b.conn!.repo).toBe("t-core");
    expect(b.conn!.service).toBeUndefined();
    expect(b.members).toEqual([`${FAT}:src/Ctl.java`]);
    expect(f.stats.missingEndpoints).toBe(1);
  });

  test("thin service and fat yard machines", () => {
    const { estate, boxes } = fixture();
    const f = buildEstateFloor(estate, boxes, ROUTES);
    const svc = f.buildings.find((x) => x.id === "svc-t-sender")!;
    expect(svc.path).toBe("services/t-sender");
    expect(svc.conn!.kinds).toEqual(["service"]);
    expect(svc.members).toEqual([`${THIN}:src/T.java`]);
    const yard = f.buildings.find((x) => x.id === "yard-t-core")!;
    expect(yard.conn!.kinds).toEqual(["yard"]);
    expect(yard.members).toEqual([`${FAT}:src/Client.java`]);
    // Entity files and the contract-free component stay off the floor.
    expect(f.stats.unmappedFiles).toBe(11);
    expect(f.buildings.some((x) => x.path.includes("Plain"))).toBe(false);
  });

  test("unboxed tables stay visible", () => {
    const { estate, boxes } = fixture();
    const f = buildEstateFloor(estate, boxes, ROUTES);
    const u = f.buildings.find((x) => x.id === "unboxed-orphan-table")!;
    expect(u.path).toBe("shelf/unboxed-orphan-table");
    expect(u.conn!.tables).toEqual([
      { table: "orphan-table", access: "unknown", via: "repository", derived: "explicit", through: "no endpoint reaches this table" },
    ]);
  });

  test("matched calls become http belts with cites", () => {
    const { estate, boxes } = fixture();
    const f = buildEstateFloor(estate, boxes, ROUTES);
    const belt = f.belts.find((e) => e.kind === "http")!;
    expect(belt.fromId).toBe("yard-t-core");
    expect(belt.toId).toBe("svc-t-sender");
    expect(belt.via![0]).toMatch(/^GET \/t — line 5: /);
    expect(f.stats.callBelts).toBe(1);
  });

  test("self calls skip, dangling targets count unowned", () => {
    const { estate, boxes } = fixture();
    const key = `${FAT}\0src/Client.java`;
    estate.byFile[key]!.calls.push(
      { method: "GET", path: "/self", via: "feign", caller: "Client.me", line: 9, matchedPath: `${FAT}:src/Client.java` },
      { method: "GET", path: "/gone", via: "feign", caller: "Client.gone", line: 11, matchedPath: "R:gone/File.java" },
      { method: "GET", path: "/unmatched", via: "feign", caller: "Client.u", line: 13 },
    );
    const f = buildEstateFloor(estate, boxes, ROUTES);
    expect(f.stats.skippedSelf).toBe(1);
    expect(f.stats.skippedUnowned).toBe(1);
    expect(f.stats.unmatchedSkipped).toBe(1);
    expect(f.stats.callBelts).toBe(1);
  });

  test("shared endpoints couple big boxes", () => {
    const shared = Array.from({ length: 8 }, (_, i) => ep("GET", `/s${i}`, [table("t1")], "s", 100 + i));
    const estate: EstateJson = {
      repos: [{ repo: FAT }],
      byFile: {
        ...entityFiles(),
        [`${FAT}\0src/Ctl.java`]: entry({ repo: FAT, kinds: ["controller"], endpoints: shared }),
      },
    };
    const ids = shared.map((e) => `${FAT}:src/Ctl.java:GET ${e.path}`);
    const mk = (id: string): BoxJson => box({
      id, name: id, tables: ["t1", "t2"], tableCount: 2, endpointCount: 8, fileCount: 1,
      repos: [FAT], files: [`${FAT}:src/Ctl.java`], endpoints: ids,
    });
    const f = buildEstateFloor(estate, { boxes: [mk("box-01"), mk("box-02")], unboxed: [] }, []);
    expect(f.stats.couplingBelts).toBe(1);
    const belt = f.belts.find((e) => e.kind === undefined)!;
    expect([belt.fromId, belt.toId].sort()).toEqual(["box-01", "box-02"]);
    expect(belt.via).toHaveLength(8);
    expect(belt.via![0]).toMatch(/^shared endpoint GET \/s0 — line 100: /);
    expect(belt.via!.at(-1)).toMatch(/^shared endpoint GET \/s7 — line 107: /);
  });

  test("deterministic across runs", () => {
    const { estate, boxes } = fixture();
    const a = buildEstateFloor(estate, boxes, ROUTES);
    const b = buildEstateFloor(structuredClone(estate), structuredClone(boxes), ROUTES);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("gateway routes mark exposure per service without mutating inputs", () => {
    const { estate, boxes } = fixture();
    const before = JSON.stringify(estate);
    // Only the core route ships: FAT endpoints face frontends, THIN stays internal.
    const f = buildEstateFloor(estate, boxes, ROUTES.slice(0, 1));
    expect(JSON.stringify(estate)).toBe(before);
    const box = f.buildings.find((x) => x.id === "box-01")!;
    expect(box.conn!.endpoints.map((e) => `${e.method} ${e.path}:${e.exposed}`)).toEqual(["GET /a:true", "POST /b:true"]);
    const svc = f.buildings.find((x) => x.id === "svc-t-sender")!;
    expect(svc.conn!.endpoints.map((e) => e.exposed)).toEqual([false]);
  });

  test("shapeless frontend input fails fast", () => {
    const { estate, boxes } = fixture();
    expect(() => buildEstateFloor(estate, boxes, ROUTES, { repo: "FE" } as unknown as FrontendJson)).toThrow("frontend-calls.json");
  });

  test("frontend machines group calls by app with honest destinations", () => {
    const { estate, boxes } = fixture();
    const frontend: FrontendJson = {
      repo: "FE", commit: "abc",
      calls: [
        { method: "GET", path: "/a", file: "libs/a.ts", line: 1, app: "compras", match: { kind: "exact", repo: FAT, file: "src/Ctl.java" }, intent: null },
        { method: "POST", path: "/b", file: "libs/a.ts", line: 9, app: "compras", match: { kind: "literal-param", repo: FAT, file: "src/Ctl.java" }, intent: null },
        { method: "GET", path: "/void", file: "apps/compras/x.ts", line: 5, app: "compras", match: null, intent: THIN },
        { method: "GET", path: "/nowhere", file: "libs/b.ts", line: 2, app: "shared", match: null, intent: "UM.nope" },
      ],
    };
    const f = buildEstateFloor(estate, boxes, ROUTES, frontend);
    expect(f.stats.frontendMachines).toBe(2);
    expect(f.stats.frontendCalls).toBe(4);
    expect(f.stats.frontendUnmatched).toBe(2);
    const fe = f.buildings.find((x) => x.id === "fe-compras")!;
    expect(fe.path).toBe("frontend/fe-compras");
    expect(fe.members).toEqual(["FE:apps/compras/x.ts", "FE:libs/a.ts"]);
    expect(fe.conn!.kinds).toEqual(["frontend"]);
    expect(fe.conn!.service).toBe("compras");
    expect(fe.conn!.calls.map((c) => c.matchedPath ?? "unresolved")).toEqual([
      "unresolved", `${FAT}:src/Ctl.java`, `${FAT}:src/Ctl.java`,
    ]);
    // Matched calls belt to the owning box; the kind tag survives on the cite.
    const toBox = f.belts.find((e) => e.fromId === "fe-compras" && e.toId === "box-01")!;
    expect(toBox.kind).toBe("http");
    expect(toBox.via).toEqual([
      "GET /a — line 1: libs/a.ts (angular) → Ctl.java",
      "POST /b — line 9: libs/a.ts (angular, literal-param) → Ctl.java",
    ]);
    // Unmatched calls belt to the implied service with an UNMATCHED cite.
    const toSvc = f.belts.find((e) => e.fromId === "fe-compras" && e.toId === "svc-t-sender")!;
    expect(toSvc.via).toEqual([
      "GET /void — UNMATCHED line 5: apps/compras/x.ts (angular) → t-sender (no such endpoint)",
    ]);
    // No intent machine: counted, off the floor.
    expect(f.stats.skippedUnowned).toBe(1);
    expect(f.belts.some((e) => e.fromId === "fe-shared")).toBe(false);
  });
});

describe("parseGatewayRoutes", () => {
  test("reads id, uri, and Path= per route block", () => {
    const yml = [
      "routes:",
      "  - id: tesoreria-core-service",
      "    uri: lb://tesoreria-core-service",
      "    predicates:",
      "      - Path=/api/tesoreria/core/**",
      "  - id: pyafipws-service",
      "    uri: lb://pyafipws-service",
      "    predicates:",
      "      - Path=/api/afipws/**",
      "",
    ].join("\n");
    expect(parseGatewayRoutes(yml)).toEqual([
      { id: "tesoreria-core-service", service: "tesoreria-core-service", path: "/api/tesoreria/core" },
      { id: "pyafipws-service", service: "pyafipws-service", path: "/api/afipws" },
    ]);
    expect(() => parseGatewayRoutes("no routes here")).toThrow("no routes");
  });
});

describe("isExposed", () => {
  const routes = [
    { id: "tesoreria-core-service", service: "tesoreria-core-service", path: "/api/tesoreria/core" },
    { id: "pyafipws-service", service: "pyafipws-service", path: "/api/afipws" },
  ];
  test("exact, declared-name, or dash-boundary match", () => {
    expect(isExposed("UM.tesoreria.core-service", undefined, routes)).toBe(true);
    expect(isExposed("UM.tesoreria.core-service", "tesoreria-core-service", routes)).toBe(true);
    // Repo slug carries the area prefix the route drops.
    expect(isExposed("UM.tesoreria.pyafipws-service", undefined, routes)).toBe(true);
  });
  test("backend, proxy, and unknown stay internal", () => {
    // Gateway reaches tesoreria-chequera-backend; the proxy repo itself has no route.
    expect(isExposed("UM.tesoreria.chequera-proxy", "tesoreria-chequera-proxy", routes)).toBe(false);
    expect(isExposed("UM.tesoreria.compras-service", undefined, routes)).toBe(false);
    expect(isExposed("UM.tesoreria.core-service", undefined, [])).toBe(false);
  });
});
