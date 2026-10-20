/**
 * Slice 3: belt derived data + classification. Golden sets over small
 * named graphs plus hysteresis ladders — set membership and counts,
 * never hand-copied reimplementations.
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateZones,
  classifyAggregates,
  classifyRoutes,
  countDegrees,
  countPips,
  degradeStep,
  needsReroute,
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
