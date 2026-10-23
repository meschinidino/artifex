/**
 * Slice 3: belt derived data + classification. Golden sets over small
 * named graphs plus hysteresis ladders — set membership and counts,
 * never hand-copied reimplementations.
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateZones,
  beltContentHash,
  beltHoverLabel,
  beltKindOf,
  beltLabelFor,
  beltWidth,
  BELT_BUCKETS,
  classifyAggregates,
  classifyRoutes,
  citationText,
  countCiteItems,
  countDegrees,
  countPips,
  degradeStep,
  extractCarried,
  formatBeltLabel,
  HUB_IN_DEGREE,
  isHubBelt,
  kindDash,
  langOfPath,
  needsReroute,
  parseContractItem,
  parseImportCitation,
  parseJvmImportLine,
  parsePyImportLine,
  parseTsImportLine,
  parseUsesItem,
  phraseForContract,
  phraseForHttpCall,
  phraseForTopic,
  routableBuildings,
  shouldCoalesce,
  tickCounts,
} from "./belts-view.ts";
import { inspectorRows } from "./machines.ts";
import type { ZoneRect } from "./layout.ts";
import type { RoutedPath } from "./route.ts";
import type { BeltEdge, Building } from "./wire.ts";

function building(over: Partial<Building> = {}): Building {
  return {
    id: "b1",
    path: "a.ts",
    zoneId: "za",
    x: 0,
    y: 0,
    band: 0,
    lines: 10,
    bytes: 100,
    mtimeMs: 1000,
    binary: false,
    parse: "ok",
    unresolvedCount: 0,
    ...over,
  };
}

function zone(over: Partial<ZoneRect> = {}): ZoneRect {
  return { id: "za", name: "za", x: 0, y: 0, w: 100, h: 100, fileCount: 1, ...over };
}

function route(fromId: string, toId: string, pts: [number, number][] = [[0, 0], [10, 10]]): RoutedPath {
  return { fromId, toId, pts, chev: [], len: 20, bus: false, lane: -1, overflow: false };
}

// Shared graph: zone A {a1, a2}, zone B {b1}; a1→b1 ×2, b1→a1,
// a1→a2 (same-zone), plus two ghost edges (unknown endpoints).
const A1 = building({ id: "a1", zoneId: "za" });
const A2 = building({ id: "a2", zoneId: "za" });
const B1 = building({ id: "b1", zoneId: "zb" });
const GRAPH_BELTS: BeltEdge[] = [
  { fromId: "a1", toId: "b1" },
  { fromId: "a1", toId: "b1" },
  { fromId: "b1", toId: "a1" },
  { fromId: "a1", toId: "a2" },
  { fromId: "a1", toId: "ghost" },
  { fromId: "ghost", toId: "a1" },
];

describe("countDegrees + countPips", () => {
  // Value: protects=fan-in/fan-out accounting under the pips and
  // congestion; fails_when=ghost edges leak in (phantom pips) or
  // counting drops multi-edges; why_new=Slice 3; seam=none.
  test("degrees skip unknown endpoints, count multi-edges and self-loops", () => {
    const { byId, inDegree, outDegree } = countDegrees([A1, A2, B1], GRAPH_BELTS);
    expect(byId.size).toBe(3);
    expect(Object.fromEntries(inDegree)).toEqual({ b1: 2, a1: 1, a2: 1 });
    expect(Object.fromEntries(outDegree)).toEqual({ a1: 3, b1: 1 });
    const solo = countDegrees([building({ id: "s" })], [{ fromId: "s", toId: "s" }]);
    expect(solo.inDegree.get("s")).toBe(1);
    expect(solo.outDegree.get("s")).toBe(1);
  });

  // Value: protects=pip cap rule max(in,out)≤5; fails_when=cap drifts
  // (pips overflow small machines); why_new=Slice 3; seam=none.
  test("pips take the max fan capped at 5, cross-checked with the inspector", () => {
    const { inDegree, outDegree } = countDegrees([A1, A2, B1], GRAPH_BELTS);
    expect(Object.fromEntries(countPips(inDegree, outDegree))).toEqual({ b1: 2, a1: 3, a2: 1 });
    expect(Object.fromEntries(countPips(new Map([["x", 9]]), new Map([["x", 2]])))).toEqual({ x: 5 });
    // Same graph through the inspector: it counts raw edges (ghosts
    // included) while degrees skip them — "2 / 4" pins the difference.
    expect(inspectorRows(A1, GRAPH_BELTS).belts).toBe("2 / 4");
    // On the ghost-free slice the two accountings agree.
    expect(inspectorRows(A1, GRAPH_BELTS.slice(0, 4)).belts).toBe("1 / 3");
  });
});

describe("aggregateZones", () => {
  // Value: protects=far-band rollup grouping; fails_when=same-zone
  // pairs leak in (rollup double-counts), directions merge, or the
  // pair separator corrupts ids with spaces; why_new=Slice 3.
  test("cross-zone directional pairs, same-zone and ghosts excluded", () => {
    const { byId } = countDegrees([A1, A2, B1], GRAPH_BELTS);
    expect(aggregateZones(byId, GRAPH_BELTS)).toEqual([
      { a: "za", b: "zb", count: 2 },
      { a: "zb", b: "za", count: 1 },
    ]);
  });

  // Value: protects=zone ids containing spaces; fails_when=the pair
  // key uses a space separator (ids split apart); why_new=Slice 3
  // (pins the NUL separator choice); seam=none.
  test("zone ids with spaces survive grouping", () => {
    const w1 = building({ id: "w1", zoneId: "my zone" });
    const w2 = building({ id: "w2", zoneId: "other place" });
    const { byId } = countDegrees([w1, w2], [{ fromId: "w1", toId: "w2" }]);
    expect(aggregateZones(byId, [{ fromId: "w1", toId: "w2" }])).toEqual([{ a: "my zone", b: "other place", count: 1 }]);
  });
});

describe("needsReroute + shouldCoalesce", () => {
  // Value: protects=fresh routes after reconnects (a restarted
  // server reuses version numbers); fails_when=the identity leg
  // drops (ghost belts from the previous boot); why_new=Slice 3.
  test("version move or new belts array re-routes", () => {
    const belts: BeltEdge[] = [{ fromId: "a", toId: "b" }];
    expect(needsReroute(undefined, 1, belts)).toBe(true);
    expect(needsReroute({ version: 1, belts }, 1, belts)).toBe(false);
    expect(needsReroute({ version: 1, belts }, 2, belts)).toBe(true);
    expect(needsReroute({ version: 1, belts }, 1, [...belts])).toBe(true);
  });

  // Value: protects=patch-burst coalescing at 250 ms; fails_when=the
  // window drifts (route storms or stale plates); why_new=Slice 3.
  test("coalesce strictly inside the 250 ms window", () => {
    expect(shouldCoalesce(1000, 1000)).toBe(true);
    expect(shouldCoalesce(1000, 1249)).toBe(true);
    expect(shouldCoalesce(1000, 1250)).toBe(false);
    expect(shouldCoalesce(1000, 9999)).toBe(false);
  });
});

describe("degradeStep", () => {
  // Value: protects=chevron/tick degrade without boundary flicker;
  // fails_when=hysteresis collapses to one threshold (decoration
  // strobes near 50/35 ms); why_new=Slice 3. Full trip/hold/clear.
  test("trips above 50, clears below 35, holds between", () => {
    expect(degradeStep(51, false)).toBe(true);
    expect(degradeStep(999, false)).toBe(true);
    expect(degradeStep(40, true)).toBe(true);
    expect(degradeStep(40, false)).toBe(false);
    expect(degradeStep(50, false)).toBe(false);
    expect(degradeStep(50, true)).toBe(true);
    expect(degradeStep(35, true)).toBe(true);
    expect(degradeStep(35, false)).toBe(false);
    expect(degradeStep(34, true)).toBe(false);
    expect(degradeStep(0, true)).toBe(false);
  });
});

describe("routableBuildings", () => {
  // Value: protects=router input (zone order + bus floor);
  // fails_when=order mapping drifts (long-haul misclassified) or the
  // floor bottom drops zones (bus band overlaps machines);
  // why_new=Slice 3; seam=none.
  test("zone order, unknown-zone default, and floor bottom", () => {
    const zones = [zone({ id: "za", y: 0, h: 100 }), zone({ id: "zb", y: 200, h: 150 })];
    const bs = [A1, B1, building({ id: "zz", zoneId: "nope" })];
    const { list, floorBottom } = routableBuildings(bs, zones);
    expect(list.map((b) => [b.id, b.zoneOrder])).toEqual([
      ["a1", 0],
      ["b1", 1],
      ["zz", 0],
    ]);
    expect(list[0]).toMatchObject({ x: A1.x, y: A1.y, band: A1.band });
    expect(floorBottom).toBe(350);
    expect(routableBuildings(bs, []).floorBottom).toBe(0);
  });
});

describe("classifyRoutes", () => {
  const byId = new Map([A1, A2, B1].map((b) => [b.id, b]));
  const wide = { x: 0, y: 0, w: 1000, h: 1000 };
  const all = new Set(["a1", "a2", "b1"]);

  // Value: protects=mid/near belt gating (cap-cut machines, unknown
  // endpoints, culled paths drop; pulses go live); fails_when=the
  // visibleIds gate drops (belts end at empty pad space);
  // why_new=Slice 3; seam=none.
  test("drops unrendered/unknown/culled, splits live from struct", () => {
    const routes = [
      route("a1", "b1"),
      route("b1", "a1"),
      route("a1", "cut"),
      route("ghost", "a1"),
      route("a1", "b1", [
        [5000, 5000],
        [5100, 5100],
      ]),
    ];
    const c = classifyRoutes(routes, byId, all, undefined, new Set(["a1"]), wide);
    expect(c.drawn).toBe(2);
    expect(c.endpoints).toEqual([
      ["a1", "b1"],
      ["b1", "a1"],
    ]);
    expect(c.live).toHaveLength(2);
    expect(c.struct).toHaveLength(0);
    expect(c.dimmed).toHaveLength(0);
    const d = classifyRoutes(routes, byId, all, undefined, new Set(), wide);
    expect(d.live).toHaveLength(0);
    expect(d.struct).toHaveLength(2);
  });

  // Value: protects=selection isolation (non-incident dims, drawn
  // counts only incident); fails_when=incident logic drifts
  // (selection shows foreign belts); why_new=Slice 3; seam=none.
  test("selection dims non-incident routes and narrows drawn", () => {
    const routes = [route("a1", "b1"), route("b1", "a1"), route("a2", "a1")];
    const c = classifyRoutes(routes, byId, all, "b1", new Set(), wide);
    expect(c.drawn).toBe(2);
    expect(c.struct.map((r) => [r.fromId, r.toId])).toEqual([
      ["a1", "b1"],
      ["b1", "a1"],
    ]);
    expect(c.dimmed.map((r) => [r.fromId, r.toId])).toEqual([["a2", "a1"]]);
  });

  // Value: protects=selection spotlight past the rendered set
  // (incident routes to unrendered targets draw; non-incident to
  // unrendered still drops; no-selection gating unchanged);
  // fails_when=the bypass leaks (unselected floors draw to empty
  // pads) or the gate over-applies (a zoomed selection
  // spotlights nothing off-view).
  test("selection spotlights incident routes past the rendered set", () => {
    const routes = [route("a1", "b1"), route("a2", "a1")];
    const partial = new Set(["a1"]); // b1 and a2 cut from the render set
    const c = classifyRoutes(routes, byId, partial, "a1", new Set(), wide);
    expect(c.drawn).toBe(2);
    expect(c.struct.map((r) => [r.fromId, r.toId])).toEqual([
      ["a1", "b1"],
      ["a2", "a1"],
    ]);
    expect(c.dimmed).toHaveLength(0);
    // No selection: the gate applies to everything.
    const d = classifyRoutes(routes, byId, partial, undefined, new Set(), wide);
    expect(d.drawn).toBe(0);
    // Non-incident under a selection keeps the gate (gated out,
    // not dimmed); incident still draws past it.
    const e = classifyRoutes(routes, byId, partial, "b1", new Set(), wide);
    expect(e.drawn).toBe(1);
    expect(e.struct.map((r) => [r.fromId, r.toId])).toEqual([["a1", "b1"]]);
    expect(e.dimmed).toHaveLength(0);
  });
});

describe("classifyAggregates", () => {
  const za = zone({ id: "za", x: 0, y: 0, w: 100, h: 100 });
  const zb = zone({ id: "zb", x: 200, y: 0, w: 100, h: 100 });
  const zd = zone({ id: "zd", x: 400, y: 0, w: 100, h: 100 });
  const zoneById = new Map([za, zb, zd].map((z) => [z.id, z]));
  const wide = { x: -1000, y: -1000, w: 5000, h: 5000 };
  const pairs = [
    { a: "za", b: "zb", count: 2 },
    { a: "zb", b: "zd", count: 3 },
    { a: "za", b: "zd", count: 9 },
  ];
  const lane = (width: number, live: boolean, lanes: { width: number; live: boolean; aggs: unknown[] }[]) =>
    lanes.find((l) => l.width === width && l.live === live)!.aggs;

  // Value: protects=rollup width buckets + live/steel split;
  // fails_when=bucket boundaries drift (2→mid) or the live rule
  // drops a leg (fresh pairs render steel); why_new=Slice 3.
  test("buckets 2→thin, 3→mid, 9→wide; pulsed zones go live", () => {
    const lanes = classifyAggregates(pairs, zoneById, new Set(["za"]), undefined, wide);
    expect(lanes).toHaveLength(6);
    expect(lane(1.75, true, lanes)).toEqual([{ a: "za", b: "zb", count: 2 }]);
    expect(lane(4, false, lanes)).toEqual([{ a: "zb", b: "zd", count: 3 }]);
    expect(lane(6, true, lanes)).toEqual([{ a: "za", b: "zd", count: 9 }]);
    expect(lane(1.75, false, lanes)).toEqual([]);
  });

  // Value: protects=selection narrowing + missing-zone/cull drops;
  // fails_when=narrowing drops (selection shows the whole rollup)
  // or missing zones throw; why_new=Slice 3; seam=none.
  test("selection narrows to its zone; missing and culled pairs drop", () => {
    const lanes = classifyAggregates(pairs, zoneById, new Set(), "zb", wide);
    const kept = lanes.flatMap((l) => l.aggs);
    expect(kept).toHaveLength(2);
    // The selection's own zone reads live even without pulses.
    expect(lane(1.75, true, lanes)).toEqual([{ a: "za", b: "zb", count: 2 }]);
    const ghost = classifyAggregates([{ a: "za", b: "nope", count: 5 }], zoneById, new Set(), undefined, wide);
    expect(ghost.flatMap((l) => l.aggs)).toEqual([]);
    const tight = { x: 10000, y: 10000, w: 10, h: 10 };
    const culled = classifyAggregates(pairs, zoneById, new Set(), undefined, tight);
    expect(culled.flatMap((l) => l.aggs)).toEqual([]);
  });
});

describe("tickCounts", () => {
  // Value: protects=item-tick budgets (per-belt and per-frame caps);
  // fails_when=caps drift (tick storms on dense floors);
  // why_new=Slice 3; seam=none.
  test("min(3, len/64) per belt, 48 per frame with starvation order", () => {
    expect(tickCounts([0, 63, 64, 200, 10000])).toEqual([0, 0, 1, 3, 3]);
    const many = tickCounts(new Array(20).fill(200));
    expect(many.slice(0, 16)).toEqual(new Array(16).fill(3));
    expect(many.slice(16)).toEqual(new Array(4).fill(0));
    expect(many.reduce((a, b) => a + b, 0)).toBe(48);
  });
});

describe("typed belts (Pass 1)", () => {
  const edge = (over: Partial<BeltEdge> = {}): BeltEdge => ({ fromId: "a", toId: "b", ...over });

  test("beltKindOf defaults absent kind to import", () => {
    expect(beltKindOf(edge())).toBe("import");
    expect(beltKindOf(edge({ kind: "http" }))).toBe("http");
    expect(beltKindOf(edge({ kind: "topic" }))).toBe("topic");
  });

  test("kindDash: import solid, http long-dash, topic dotted", () => {
    expect(kindDash("import")).toBeUndefined();
    expect(kindDash("http")).toEqual([11, 5]);
    expect(kindDash("topic")).toEqual([2, 4]);
    // Never the ghost's [5, 4]: kind dashes must not read as ghosts.
    expect(kindDash("http")).not.toEqual([5, 4]);
    expect(kindDash("topic")).not.toEqual([5, 4]);
  });

  test("beltWidth buckets by citation count", () => {
    expect(BELT_BUCKETS).toHaveLength(3);
    expect(beltWidth(0)).toBe(1.5);
    expect(beltWidth(1)).toBe(1.5);
    expect(beltWidth(2)).toBe(2.5);
    expect(beltWidth(3)).toBe(4);
    expect(beltWidth(99)).toBe(4);
  });

  test("parseUsesItem unfolds names and the +N tail", () => {
    expect(parseUsesItem("uses A, B")).toEqual({ names: ["A", "B"], total: 2 });
    expect(parseUsesItem("uses A, B, +3 more")).toEqual({ names: ["A", "B"], total: 5 });
    expect(parseUsesItem("uses fmt: Printf, Sprintf")).toEqual({ names: ["Printf", "Sprintf"], total: 2 });
    expect(parseUsesItem("uses ns.*")).toEqual({ names: ["ns.*"], total: 1 });
    expect(parseUsesItem("line 3: import { A } from './x'")).toBeUndefined();
    expect(parseUsesItem("uses ")).toBeUndefined();
  });

  test("parseContractItem reads http paths and topic names", () => {
    expect(parseContractItem("GET /users — line 12: fetch('/users')", "http")).toBe("GET /users");
    expect(parseContractItem("GET /users — line 12", "http")).toBe("GET /users");
    expect(parseContractItem("GET /users", "http")).toBeUndefined();
    expect(parseContractItem("orders via handle — line 3: emit('orders')", "topic")).toBe("orders");
    expect(parseContractItem("orders — line 3", "topic")).toBe("orders");
    expect(parseContractItem("two words — line 3", "topic")).toBeUndefined();
    expect(parseContractItem("GET /users — line 12", "import")).toBeUndefined();
  });

  test("citationText strips the line prefix", () => {
    expect(citationText("line 12: import { A } from './x'")).toBe("import { A } from './x'");
    expect(citationText("line 12")).toBeUndefined();
    expect(citationText("uses A")).toBeUndefined();
  });

  test("langOfPath maps extensions", () => {
    expect(langOfPath("a.ts")).toBe("ts");
    expect(langOfPath("a.tsx")).toBe("ts");
    expect(langOfPath("a.mjs")).toBe("ts");
    expect(langOfPath("a.py")).toBe("py");
    expect(langOfPath("A.java")).toBe("jvm");
    expect(langOfPath("a.kt")).toBe("jvm");
    expect(langOfPath("a.go")).toBe("go");
    expect(langOfPath("a.rs")).toBe("other");
    expect(langOfPath("README.md")).toBe("other");
  });

  test("parseTsImportLine binds locals, namespaces, and re-exports", () => {
    expect(parseTsImportLine(`import { A, B } from './x';`)).toEqual(["A", "B"]);
    expect(parseTsImportLine(`import D, { A } from "./x"`)).toEqual(["D", "A"]);
    expect(parseTsImportLine(`import * as ns from './x';`)).toEqual(["ns.*"]);
    expect(parseTsImportLine(`import D from './x';`)).toEqual(["D"]);
    expect(parseTsImportLine(`export { A, B as C } from './x';`)).toEqual(["A", "C"]);
    expect(parseTsImportLine(`import { X as Y } from './x';`)).toEqual(["Y"]);
    expect(parseTsImportLine(`import type { A } from './x';`)).toEqual(["A"]);
    expect(parseTsImportLine(`import D, * as ns from './x';`)).toEqual(["D", "ns.*"]);
    expect(parseTsImportLine(`import './x';`)).toEqual([]);
    expect(parseTsImportLine(`export * from './x';`)).toEqual([]);
    expect(parseTsImportLine(`import { A, B } from './x…`)).toEqual([]);
    expect(parseTsImportLine(`import { A, /* c */ B } from './x';`)).toEqual([]);
    expect(parseTsImportLine(`import { A,`)).toEqual([]);
  });

  test("parsePyImportLine binds from/plain/as forms", () => {
    expect(parsePyImportLine("from x import a, b")).toEqual(["a", "b"]);
    expect(parsePyImportLine("from x import (a, b)")).toEqual(["a", "b"]);
    expect(parsePyImportLine("from x import a as c")).toEqual(["c"]);
    expect(parsePyImportLine("import a, b")).toEqual(["a", "b"]);
    expect(parsePyImportLine("import a.b")).toEqual(["a.b"]);
    expect(parsePyImportLine("import a as b")).toEqual(["b"]);
    expect(parsePyImportLine("from x import a  # trailing")).toEqual(["a"]);
    expect(parsePyImportLine("from x import (a,")).toEqual([]);
    expect(parsePyImportLine("from x import a…")).toEqual([]);
    expect(parsePyImportLine("x = 1")).toEqual([]);
  });

  test("parseJvmImportLine yields the last segment", () => {
    expect(parseJvmImportLine("import com.foo.Bar;")).toEqual(["Bar"]);
    expect(parseJvmImportLine("import static com.foo.Bar.baz;")).toEqual(["baz"]);
    expect(parseJvmImportLine("import com.foo.*;")).toEqual([]);
    expect(parseJvmImportLine("import com.foo.Bar…")).toEqual([]);
    expect(parseJvmImportLine("package com.foo;")).toEqual([]);
  });

  test("parseImportCitation covers ts/py/jvm only", () => {
    expect(parseImportCitation(`import { A } from './x';`, "ts")).toEqual(["A"]);
    expect(parseImportCitation("from x import a", "py")).toEqual(["a"]);
    expect(parseImportCitation("import com.foo.Bar;", "jvm")).toEqual(["Bar"]);
    expect(parseImportCitation(`import "fmt"`, "go")).toEqual([]);
    expect(parseImportCitation("use foo::bar;", "other")).toEqual([]);
  });

  test("extractCarried prefers uses items, then citations", () => {
    const multi = edge({ via: ["line 3: import {", "uses A, B, +1 more"] });
    expect(extractCarried(multi, "a.ts")).toEqual({ names: ["A", "B"], total: 3 });
    const single = edge({ via: ["line 3: import { A, B } from './x';"] });
    expect(extractCarried(single, "a.ts")).toEqual({ names: ["A", "B"], total: 2 });
    const go = edge({ via: ['line 5: import "fmt"', "uses fmt: Printf"] });
    expect(extractCarried(go, "a.go")).toEqual({ names: ["Printf"], total: 1 });
    const http = edge({ kind: "http", via: ["GET /users — line 12: fetch('/users')"] });
    expect(extractCarried(http, "a.ts")).toEqual({ names: ["GET /users"], total: 1 });
    const topic = edge({ kind: "topic", via: ["orders via h — line 3: emit('orders')"] });
    expect(extractCarried(topic, "A.java")).toEqual({ names: ["orders"], total: 1 });
  });

  test("extractCarried bails to undefined (counts fallback)", () => {
    expect(extractCarried(edge(), "a.ts")).toBeUndefined();
    expect(extractCarried(edge({ via: [] }), "a.ts")).toBeUndefined();
    expect(extractCarried(edge({ via: ["line 5: side-effect import (no direct uses)"] }), "a.go")).toBeUndefined();
    expect(extractCarried(edge({ via: ["side-effect import (no direct uses)"] }), "a.go")).toBeUndefined();
    expect(extractCarried(edge({ via: ["line 1: use foo::bar;"] }), "a.rs")).toBeUndefined();
    expect(extractCarried(edge({ via: ["line 9"] }), "a.ts")).toBeUndefined();
  });

  test("countCiteItems skips uses/marker items", () => {
    expect(countCiteItems(edge())).toBe(0);
    const mixed = edge({ via: ["line 3: import {", "uses A, B", "side-effect import (no direct uses)"] });
    expect(countCiteItems(mixed)).toBe(1);
    const http = edge({ kind: "http", via: ["GET /a — line 1", "POST /b — line 2"] });
    expect(countCiteItems(http)).toBe(2);
  });

  test("formatBeltLabel caps names, counts from two up", () => {
    expect(formatBeltLabel({ names: ["A", "B", "C"], total: 5 }, 3)).toBe("A, B +3");
    expect(formatBeltLabel({ names: ["A", "B"], total: 2 }, 1)).toBe("A, B");
    expect(formatBeltLabel({ names: ["A"], total: 1 }, 1)).toBe("A");
    expect(formatBeltLabel(undefined, 3)).toBe("×3");
    expect(formatBeltLabel(undefined, 2)).toBe("×2");
    expect(formatBeltLabel(undefined, 1)).toBeUndefined();
    expect(formatBeltLabel(undefined, 0)).toBeUndefined();
  });

  test("isHubBelt gates on either endpoint in-degree", () => {
    expect(HUB_IN_DEGREE).toBe(5);
    const deg = new Map([
      ["a", 1],
      ["b", 5],
    ]);
    expect(isHubBelt(edge(), deg)).toBe(true);
    expect(isHubBelt(edge({ fromId: "x", toId: "y" }), deg)).toBe(false);
  });

  test("beltLabelFor gates by band", () => {
    const single = edge({ via: ["line 3: import { A } from './x';"] });
    const deg = new Map<string, number>();
    expect(beltLabelFor("far", single, "a.ts", deg)).toBeUndefined();
    expect(beltLabelFor("near", single, "a.ts", deg)).toBe("A");
    expect(beltLabelFor("mid", single, "a.ts", deg)).toBeUndefined();
    expect(beltLabelFor("mid", single, "a.ts", new Map([["b", 5]]))).toBe("A");
    const unnamed = edge({ via: ["line 1: use a;", "line 2: use b;"] });
    expect(beltLabelFor("near", unnamed, "a.rs", deg)).toBe("×2");
  });
});

describe("purpose phrases (PPH1)", () => {
  const edge = (over: Partial<BeltEdge> = {}): BeltEdge => ({ fromId: "a", toId: "b", ...over });

  test("phraseForHttpCall maps verbs and hunts the noun", () => {
    expect(phraseForHttpCall("GET", "/api/orders")).toBe("fetches orders");
    expect(phraseForHttpCall("POST", "/api/orders")).toBe("sends orders");
    expect(phraseForHttpCall("PUT", "/api/orders/{id}")).toBe("updates orders");
    expect(phraseForHttpCall("PATCH", "/order-items")).toBe("patches order items");
    expect(phraseForHttpCall("DELETE", "/api/v2/items/{id}")).toBe("removes items");
    expect(phraseForHttpCall("POST", "/api/example/sender/chequera/send")).toBe("sends chequera");
    expect(phraseForHttpCall("GET", "/api/users/{id}/orderItems")).toBe("fetches order items");
    expect(phraseForHttpCall("GET", "/health")).toBe("fetches health");
    expect(phraseForHttpCall("HEAD", "/api/orders")).toBeUndefined();
    expect(phraseForHttpCall("GET", "/api/{id}")).toBeUndefined();
    expect(phraseForHttpCall("GET", "/")).toBeUndefined();
  });

  test("phraseForTopic publishes humanized names", () => {
    expect(phraseForTopic("orders")).toBe("publishes orders");
    expect(phraseForTopic("order-events")).toBe("publishes order events");
    expect(phraseForTopic("shop.order_created")).toBe("publishes shop order created");
    expect(phraseForTopic("-_-")).toBeUndefined();
  });

  test("phraseForContract takes the first phrase plus a tail", () => {
    const http = edge({ kind: "http", via: ["GET /api/orders — line 9: rest.getForObject('/api/orders')"] });
    expect(phraseForContract("http", http.via)).toBe("fetches orders");
    const multi = edge({
      kind: "http",
      via: ["GET /api/orders — line 9", "POST /api/orders — line 12: rest.postForObject('/api/orders')"],
    });
    expect(phraseForContract("http", multi.via)).toBe("fetches orders +1");
    const topic = edge({ kind: "topic", via: ["orders via publish — line 9: kafka.send('orders')"] });
    expect(phraseForContract("topic", topic.via)).toBe("publishes orders");
    expect(phraseForContract("import", http.via)).toBeUndefined();
    expect(phraseForContract("http", undefined)).toBeUndefined();
    expect(phraseForContract("http", ["uses A"])).toBeUndefined();
    expect(phraseForContract("http", ["BREW /api/orders — line 1"])).toBeUndefined();
  });

  test("beltLabelFor prefers the contract phrase, falls back to symbols", () => {
    const deg = new Map<string, number>();
    const http = edge({ kind: "http", via: ["GET /api/orders — line 9: rest.getForObject('/api/orders')"] });
    expect(beltLabelFor("near", http, "Shop.java", deg)).toBe("fetches orders");
    const weird = edge({ kind: "http", via: ["BREW /api/orders — line 1"] });
    expect(beltLabelFor("near", weird, "Shop.java", deg)).toBe("BREW /api/orders");
  });

  test("beltLabelFor prefers the server phrase on import belts only", () => {
    const deg = new Map<string, number>();
    const imp = edge({ via: ["line 3: import { A } from './x';"] });
    expect(beltLabelFor("near", imp, "a.ts", deg, "uses shared widgets")).toBe("uses shared widgets");
    expect(beltLabelFor("near", imp, "a.ts", deg)).toBe("A");
    const http = edge({ kind: "http", via: ["GET /api/orders — line 9"] });
    expect(beltLabelFor("near", http, "Shop.java", deg, "ignored")).toBe("fetches orders");
  });

  test("beltHoverLabel joins phrase and symbols", () => {
    const imp = edge({ via: ["line 3: import { A } from './x';"] });
    expect(beltHoverLabel(imp, "a.ts", "uses shared widgets")).toBe("uses shared widgets — A");
    expect(beltHoverLabel(imp, "a.ts")).toBe("A");
    const bare = edge({ via: ["line 9: import './x';", "line 10: import './y';"] });
    expect(beltHoverLabel(bare, "a.ts", "runs side effects")).toBe("runs side effects — ×2");
    const http = edge({ kind: "http", via: ["GET /api/orders — line 9"] });
    expect(beltHoverLabel(http, "Shop.java")).toBe("fetches orders — GET /api/orders");
    const silent = edge({});
    expect(beltHoverLabel(silent, "a.ts")).toBeUndefined();
  });
});

describe("beltContentHash", () => {
  const edge = (over: Partial<BeltEdge> = {}): BeltEdge => ({ fromId: "a", toId: "b", ...over });

  test("stable, order-insensitive, content-sensitive", () => {
    const one = [edge({ via: ["line 1: x"] }), edge({ fromId: "c", toId: "d", kind: "http" })];
    const reordered = [edge({ fromId: "c", toId: "d", kind: "http" }), edge({ via: ["line 1: x"] })];
    expect(beltContentHash(one)).toBe(beltContentHash(reordered));
    expect(beltContentHash(one)).toBe(beltContentHash(one));
    expect(beltContentHash([edge({ via: ["line 1: y"] })])).not.toBe(beltContentHash([edge({ via: ["line 1: x"] })]));
    expect(beltContentHash([edge({ kind: "http" })])).not.toBe(beltContentHash([edge()]));
    expect(beltContentHash([])).toBe(beltContentHash([]));
  });
});
