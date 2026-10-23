import { expect, test } from "bun:test";
import { BAND_SIZES, PITCH } from "./layout.ts";
import { BUS_LANE_CAP, nearestRoute, routeBelts, type RoutableBuilding, type RoutableEdge, type RoutedPath } from "./route.ts";

const b = (
  id: string,
  zoneOrder: number,
  x: number,
  y = 0,
  band: RoutableBuilding["band"] = 0,
): RoutableBuilding => ({ id, zoneOrder, x, y, band });
const e = (fromId: string, toId: string): RoutableEdge => ({ fromId, toId });

function isOrthogonal(pts: [number, number][]): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]![0] !== pts[i - 1]![0] && pts[i]![1] !== pts[i - 1]![1]) return false;
  }
  return true;
}

test("short hop at the same height runs straight", () => {
  const r = routeBelts([b("a", 0, 0), b("c", 0, 96)], [e("a", "c")], 200);
  expect(r.routes).toHaveLength(1);
  const [path] = r.routes;
  expect(path!.bus).toBe(false);
  expect(path!.lane).toBe(-1);
  expect(path!.pts).toHaveLength(2);
  expect(path!.pts[0]![1]).toBe(path!.pts[1]![1]);
});

test("short hop across heights jogs H-V-H", () => {
  const r = routeBelts([b("a", 0, 0), b("c", 0, 96, 96)], [e("a", "c")], 200);
  expect(r.routes).toHaveLength(1);
  const [path] = r.routes;
  expect(path!.bus).toBe(false);
  expect(path!.pts).toHaveLength(4);
  expect(isOrthogonal(path!.pts)).toBe(true);
});

test("short hop running back jogs +36 past the source", () => {
  const r = routeBelts([b("a", 0, 96), b("c", 0, 0)], [e("a", "c")], 200);
  const [path] = r.routes;
  expect(path!.bus).toBe(false);
  expect(path!.pts[1]![0] - path!.pts[0]![0]).toBe(36);
  expect(isOrthogonal(path!.pts)).toBe(true);
});

test("adjacent zones hop; zone gap 2+ rides the bus", () => {
  const buildings = [b("a", 0, 0), b("c", 1, 200), b("d", 2, 500)];
  const short = routeBelts(buildings, [e("a", "c")], 200);
  expect(short.routes[0]!.bus).toBe(false);
  const long = routeBelts(buildings, [e("a", "d")], 200);
  expect(long.routes[0]!.bus).toBe(true);
  expect(long.routes[0]!.lane).toBe(0);
  expect(long.lanes).toBe(1);
  expect(long.busBottom).toBe(200 + 24);
  // The bus run sits on the lane between the two drops.
  const ys = long.routes[0]!.pts.map((p) => p[1]);
  expect(ys).toContain(200 + 24);
});

test("a same-row blocker is detoured around, staying direct", () => {
  const buildings = [b("a", 0, 0), b("blocker", 0, 96), b("c", 0, 192)];
  const r = routeBelts(buildings, [e("a", "c")], 200);
  expect(r.routes[0]!.bus).toBe(false);
  expect(r.routes[0]!.pts).toHaveLength(6);
  expect(isOrthogonal(r.routes[0]!.pts)).toBe(true);
  // First detour tried runs 32 below the ports.
  const ys = r.routes[0]!.pts.map((p) => p[1]);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(32);
});

test("a walled corridor drops to the bus", () => {
  // Blockers at the corridor height and every detour height.
  const buildings = [
    b("a", 0, 0),
    b("c", 0, 192),
    b("w0", 0, 96, 0),
    b("w1", 0, 96, 32),
    b("w2", 0, 96, -32),
    b("w3", 0, 96, 64),
    b("w4", 0, 96, -64),
  ];
  const r = routeBelts(buildings, [e("a", "c")], 400);
  expect(r.routes[0]!.bus).toBe(true);
  expect(isOrthogonal(r.routes[0]!.pts)).toBe(true);
});

test("lanes pack: overlapping spans split, disjoint spans share", () => {
  const buildings = [
    b("a1", 0, 0),
    b("c1", 2, 500),
    b("a2", 0, 100),
    b("c2", 2, 600),
    b("a3", 0, 1000),
    b("c3", 2, 1100),
  ];
  const r = routeBelts(buildings, [e("a1", "c1"), e("a2", "c2"), e("a3", "c3")], 200);
  expect(r.lanes).toBe(2);
  expect(r.routes[0]!.lane).toBe(0);
  expect(r.routes[1]!.lane).toBe(1);
  expect(r.routes[2]!.lane).toBe(0);
  expect(r.overflow).toBe(0);
  // Value: protects=<busBottom tracks the deepest lane (fit-all frames the bus band)>;
  // fails_when=<busBottom ignores lane depth and the bus renders outside the fit view>; why_new=<busBottom
  // asserted only for 0/1 lanes elsewhere>; seam=none
  expect(r.busBottom).toBe(200 + 24 + 8);
});

test("past the lane cap, edges overflow to direct routing", () => {
  const buildings = [b("hub", 0, 0)];
  const edges: RoutableEdge[] = [];
  for (let i = 0; i < BUS_LANE_CAP + 8; i++) {
    buildings.push(b(`t${i}`, 2, 500 + i * 96));
    edges.push(e("hub", `t${i}`));
  }
  const r = routeBelts(buildings, edges, 200);
  expect(r.lanes).toBe(BUS_LANE_CAP);
  expect(r.overflow).toBe(8);
  expect(r.routes).toHaveLength(BUS_LANE_CAP + 8);
  expect(r.routes.every((p) => isOrthogonal(p.pts))).toBe(true);
  // Overflowed paths are direct (never on a lane).
  expect(r.routes.filter((p) => p.lane === -1)).toHaveLength(8);
});

test("self loops and unknown endpoints are skipped", () => {
  const r = routeBelts([b("a", 0, 0)], [e("a", "a"), e("a", "ghost"), e("ghost", "a")], 200);
  expect(r.routes).toHaveLength(0);
  expect(r.lanes).toBe(0);
  expect(r.busBottom).toBe(200);
});

test("every route carries 3 axis-aligned chevron spots", () => {
  const buildings = [b("a", 0, 0), b("c", 0, 96, 96), b("d", 2, 500)];
  const r = routeBelts(buildings, [e("a", "c"), e("a", "d")], 200);
  expect(r.routes).toHaveLength(2);
  for (const path of r.routes) {
    expect(path.chev).toHaveLength(3);
    for (const c of path.chev) {
      const quarter = c.angle / (Math.PI / 2);
      expect(Math.abs(quarter - Math.round(quarter))).toBeLessThan(1e-9);
    }
  }
});

test("direct routes never cross a third machine", () => {
  // 3x3 grid, every machine wired to two others: shorts, detours,
  // reversals, and bus drops all in play.
  const buildings: RoutableBuilding[] = [];
  for (let gx = 0; gx < 3; gx++) {
    for (let gy = 0; gy < 3; gy++) {
      buildings.push(b(`m${gx}${gy}`, 0, gx * PITCH, gy * PITCH));
    }
  }
  const edges: RoutableEdge[] = [];
  for (let i = 0; i < buildings.length; i++) {
    edges.push(e(buildings[i]!.id, buildings[(i + 4) % buildings.length]!.id));
    edges.push(e(buildings[i]!.id, buildings[(i + 7) % buildings.length]!.id));
  }
  const r = routeBelts(buildings, edges, 600);
  const rectOf = (id: string) => {
    const bd = buildings.find((x) => x.id === id)!;
    const size = BAND_SIZES[bd.band];
    const inset = (PITCH - size) / 2;
    return { x0: bd.x + inset, y0: bd.y + inset, x1: bd.x + inset + size, y1: bd.y + inset + size };
  };
  let checked = 0;
  for (const path of r.routes) {
    if (path.bus || path.overflow) continue;
    checked++;
    for (let i = 1; i < path.pts.length; i++) {
      const x0 = Math.min(path.pts[i - 1]![0], path.pts[i]![0]) - 2;
      const x1 = Math.max(path.pts[i - 1]![0], path.pts[i]![0]) + 2;
      const y0 = Math.min(path.pts[i - 1]![1], path.pts[i]![1]) - 2;
      const y1 = Math.max(path.pts[i - 1]![1], path.pts[i]![1]) + 2;
      for (const bd of buildings) {
        if (bd.id === path.fromId || bd.id === path.toId) continue;
        const rect = rectOf(bd.id);
        expect(
          x0 < rect.x1 && x1 > rect.x0 && y0 < rect.y1 && y1 > rect.y0,
          `${path.fromId}->${path.toId} seg ${i} hits ${bd.id}`,
        ).toBe(false);
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
});

// Value: protects=<parallel edges between one pair spread across distinct side ports>;
// fails_when=<port slotting collapses to one shared port (identical paths) or an edge is dropped>;
// why_new=<no existing test routes 2+ edges over the same pair>; seam=none
test("parallel edges between one pair spread across distinct ports", () => {
  const r = routeBelts([b("a", 0, 0), b("c", 0, 96)], [e("a", "c"), e("a", "c"), e("a", "c")], 200);
  expect(r.routes).toHaveLength(3);
  expect(r.overflow).toBe(0);
  for (const path of r.routes) {
    expect(path.bus).toBe(false);
    expect(isOrthogonal(path.pts)).toBe(true);
  }
  const starts = r.routes.map((p) => p.pts[0]![1]);
  expect(new Set(starts).size).toBe(3);
  const ends = r.routes.map((p) => p.pts.at(-1)![1]);
  expect(new Set(ends).size).toBe(3);
});

// Value: protects=<bus drops sidestep bystanders through side corridors instead of crossing them>;
// fails_when=<the drop goes straight through a machine, or the edge wrongly counts as overflow>;
// why_new=<existing bus tests use clear drops; the grid no-crossing invariant covers direct routes only>; seam=none
test("a bus drop sidesteps a bystander through a side corridor", () => {
  const buildings = [b("a", 0, 0), b("d", 2, 500), b("wall", 0, 0, 96)];
  const r = routeBelts(buildings, [e("a", "d")], 200);
  expect(r.routes).toHaveLength(1);
  const [path] = r.routes;
  expect(path!.bus).toBe(true);
  expect(path!.lane).toBe(0);
  expect(path!.overflow).toBe(false);
  expect(r.overflow).toBe(0);
  expect(r.lanes).toBe(1);
  expect(isOrthogonal(path!.pts)).toBe(true);
  // No segment of the routed path crosses the wall machine.
  const size = BAND_SIZES[0];
  const inset = (PITCH - size) / 2;
  const wall = { x0: 0 + inset, y0: 96 + inset, x1: 0 + inset + size, y1: 96 + inset + size };
  for (let i = 1; i < path!.pts.length; i++) {
    const x0 = Math.min(path!.pts[i - 1]![0], path!.pts[i]![0]) - 2;
    const x1 = Math.max(path!.pts[i - 1]![0], path!.pts[i]![0]) + 2;
    const y0 = Math.min(path!.pts[i - 1]![1], path!.pts[i]![1]) - 2;
    const y1 = Math.max(path!.pts[i - 1]![1], path!.pts[i]![1]) + 2;
    expect(x0 < wall.x1 && x1 > wall.x0 && y0 < wall.y1 && y1 > wall.y0, `seg ${i} hits the wall`).toBe(false);
  }
});

// Value: protects=<edges with no clear drop corridor degrade to counted direct routing (plate stays honest)>;
// fails_when=<overflow is not counted (plate lies) or the edge rides a lane through machines>;
// why_new=<the existing overflow test covers the lane cap only; the no-corridor path is untested>; seam=none
test("a walled-off drop degrades to counted direct routing", () => {
  // One blocker column per drop-candidate x below the producer port (48, 62).
  const drops = [48, 36, 60, 24, 72, 12, 84, 0, 96];
  const buildings: RoutableBuilding[] = [b("a", 0, 0), b("d", 2, 2000)];
  for (const [i, dx] of drops.entries()) buildings.push(b(`w${i}`, 1, dx - 48, 96));
  const r = routeBelts(buildings, [e("a", "d")], 200);
  expect(r.routes).toHaveLength(1);
  expect(r.overflow).toBe(1);
  expect(r.lanes).toBe(0);
  expect(r.busBottom).toBe(200);
  const [path] = r.routes;
  expect(path!.bus).toBe(false);
  expect(path!.lane).toBe(-1);
  expect(path!.overflow).toBe(true);
  expect(isOrthogonal(path!.pts)).toBe(true);
});

// Value: protects=<short hop with walled direct and walled drops overflows on its corridor>;
// fails_when=<the edge rides a lane through walls or overflows without counting>;
// why_new=<existing overflow tests cover lane-cap and long no-corridor only>; seam=none
test("a short hop with walled direct and walled drops overflows on its corridor", () => {
  // Direct walls between a and c (walled-corridor pattern) plus drop
  // walls below the producer (walled-off-drop pattern).
  const drops = [48, 36, 60, 24, 72, 12, 84, 0, 96];
  const buildings: RoutableBuilding[] = [
    b("a", 0, 0),
    b("c", 0, 192),
    b("w0", 0, 96, 0),
    b("w1", 0, 96, 32),
    b("w2", 0, 96, -32),
    b("w3", 0, 96, 64),
    b("w4", 0, 96, -64),
  ];
  for (const [i, dx] of drops.entries()) buildings.push(b(`d${i}`, 1, dx - 48, 96));
  const r = routeBelts(buildings, [e("a", "c")], 400);
  expect(r.routes).toHaveLength(1);
  expect(r.overflow).toBe(1);
  expect(r.lanes).toBe(0);
  expect(r.busBottom).toBe(400);
  const [path] = r.routes;
  expect(path!.bus).toBe(false);
  expect(path!.overflow).toBe(true);
  expect(path!.pts).toHaveLength(2);
});

// Value: protects=<larger bands spread ports across bigger edges and route bus edges>;
// fails_when=<band geometry is ignored (ports collapse) or bystander checks use band-0 size>;
// why_new=<every fixture hardcodes band 0>; seam=none
test("larger bands spread ports and route a bus edge", () => {
  const r = routeBelts(
    [b("a", 0, 0, 0, 2), b("c", 0, 96, 0, 3), b("d", 2, 500, 0, 2)],
    [e("a", "c"), e("a", "c"), e("a", "d")],
    200,
  );
  expect(r.routes).toHaveLength(3);
  expect(r.routes.every((p) => isOrthogonal(p.pts))).toBe(true);
  const shorts = r.routes.filter((p) => !p.bus);
  expect(shorts).toHaveLength(2);
  expect(new Set(shorts.map((p) => p.pts[0]![1])).size).toBe(2);
  expect(r.routes.filter((p) => p.bus)).toHaveLength(1);
});

// Value: protects=<cached path length matches a from-scratch recompute>;
// fails_when=<the route-time cache drifts from pts (stale or miscomputed)>;
// why_new=<len is a new cached field with no coverage>; seam=none
test("cached lengths match recomputed path lengths", () => {
  const buildings = [b("a", 0, 0), b("c", 0, 96, 96), b("d", 2, 500)];
  const r = routeBelts(buildings, [e("a", "c"), e("a", "d")], 200);
  expect(r.routes).toHaveLength(2);
  for (const path of r.routes) {
    let total = 0;
    for (let i = 1; i < path.pts.length; i++) {
      total += Math.abs(path.pts[i]![0] - path.pts[i - 1]![0]) + Math.abs(path.pts[i]![1] - path.pts[i - 1]![1]);
    }
    expect(path.len).toBe(total);
  }
  // A straight hop carries its exact Manhattan length.
  const straight = routeBelts([b("a", 0, 0), b("c", 0, 96)], [e("a", "c")], 200).routes[0]!;
  expect(straight.pts).toHaveLength(2);
  expect(straight.len).toBe(
    Math.abs(straight.pts[1]![0] - straight.pts[0]![0]) + Math.abs(straight.pts[1]![1] - straight.pts[0]![1]),
  );
});

test("routing is deterministic", () => {
  const buildings = [b("a", 0, 0), b("blocker", 0, 96), b("c", 0, 192), b("d", 2, 500)];
  const edges = [e("a", "c"), e("c", "d"), e("a", "d")];
  const first = routeBelts(buildings, edges, 200);
  const second = routeBelts(buildings, edges, 200);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
});

const rp = (fromId: string, toId: string, pts: [number, number][]): RoutedPath => ({
  fromId,
  toId,
  pts,
  chev: [],
  len: 0,
  bus: false,
  lane: -1,
  overflow: false,
});

test("nearestRoute picks closest, first wins ties, maxDist excludes", () => {
  const near = rp("a", "b", [[0, 0], [100, 0]]);
  const far = rp("c", "d", [[0, 50], [100, 50]]);
  expect(nearestRoute([near, far], 50, 4, 10)?.fromId).toBe("a");
  expect(nearestRoute([near, far], 50, 40, 10)).toBeUndefined();
  expect(nearestRoute([], 50, 0, 10)).toBeUndefined();
  // Equidistant: first route wins.
  const twin = rp("e", "f", [[0, 0], [100, 0]]);
  expect(nearestRoute([near, twin], 50, 4, 10)?.fromId).toBe("a");
  // Zero-length segment reads as its point.
  const dot = rp("g", "h", [[30, 30], [30, 30]]);
  expect(nearestRoute([dot], 33, 34, 10)?.fromId).toBe("g");
  expect(nearestRoute([dot], 0, 0, 10)).toBeUndefined();
  // Endpoints clamp: past the segment end measures to the end.
  expect(nearestRoute([near], 150, 0, 60)?.fromId).toBe("a");
  expect(nearestRoute([near], 150, 0, 40)).toBeUndefined();
});

test("edge keys copy to routed paths (same-pair edges stay distinct)", () => {
  const buildings = [b("a", 0, 0), b("c", 0, 96)];
  const r = routeBelts(buildings, [
    { fromId: "a", toId: "c", key: "0" },
    { fromId: "a", toId: "c", key: "1" },
  ], 200);
  expect(r.routes).toHaveLength(2);
  expect(r.routes.map((p) => p.key).sort()).toEqual(["0", "1"]);
  const unkeyed = routeBelts(buildings, [e("a", "c")], 200);
  expect(unkeyed.routes[0]!.key).toBeUndefined();
});
