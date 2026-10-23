/**
 * Orthogonal belt routing (Nightshift Phase 3): per-edge port slots
 * on machine edges, H/V jogs for short hops, a bottom bus band with
 * packed per-edge lanes for long-haul, bystander detection with bus
 * fallback. Pure and version-cached by the caller (getBeltCache):
 * route on version change, never per frame.
 *
 * Adapted from the reviewed preview to real scale: zones keep their
 * server-owned rects, so the bus band hangs below the floor instead
 * of growing zone pads, and lanes are interval-packed (not ordinal)
 * so dense floors share them. Cost is O(edges x buildings) per
 * route; the file-count ceiling (roadmap P2) bounds both.
 */

import { BAND_SIZES, PITCH, type Band } from "./layout.ts";

export type RoutableBuilding = {
  id: string;
  /** Index of the zone in floor order (stable per floor version). */
  zoneOrder: number;
  /** Slot origin in world units; footprint derives from band. */
  x: number;
  y: number;
  band: Band;
};

export type RoutableEdge = {
  fromId: string;
  toId: string;
  /** Opaque caller key, copied to the routed path (edge identity for styling). */
  key?: string;
};

export type ChevronSpot = {
  x: number;
  y: number;
  /** Path direction at the spot, radians (axis-aligned). */
  angle: number;
};

export type RoutedPath = {
  fromId: string;
  toId: string;
  /** Orthogonal polyline, producer port to consumer port. */
  pts: [number, number][];
  /** Chevron spots at 30/55/80% of path length. */
  chev: ChevronSpot[];
  /** Total orthogonal length, cached at route time. */
  len: number;
  /** True when the path rides the bus band. */
  bus: boolean;
  /** Bus lane index, or -1 for direct routes. */
  lane: number;
  /** True for counted degradation (may cross machines; the plate says so). */
  overflow: boolean;
  /** Caller key copied from the routed edge, when one was supplied. */
  key?: string;
};

export type RouteResult = {
  routes: RoutedPath[];
  /** Bus lanes in use. */
  lanes: number;
  /** Edges that fell back to direct routing (lane cap or no corridor). */
  overflow: number;
  /** World y of the deepest bus lane (floorBottom when unlaned). */
  busBottom: number;
};

/** Zone gap at or past which an edge rides the bus (preview rule). */
const LONG_HAUL_ZONE_GAP = 2;
/** Bus lanes at 8px pitch below the floor; past the cap, edges fall
 * back to direct orthogonal routing and the floor says so on a plate. */
export const BUS_LANE_CAP = 32;
const BUS_LANE_PITCH = 8;
const BUS_TOP_MARGIN = 24;
/** Fractions of path length carrying chevrons (preview train). */
const CHEV_FRACS = [0.3, 0.55, 0.8];
/** Drop-corridor search offsets beside the port (world units). */
const DROP_TRIES = [0, -12, 12, -24, 24, -36, 36, -48, 48];
/** Run-back jog for reverse short hops (world units). */
const JOG_BACK = 36;

type Rect = { id: string; x0: number; y0: number; x1: number; y1: number };
type Seg = [number, number, number, number];

function machineRect(b: RoutableBuilding): Rect {
  const size = BAND_SIZES[b.band];
  const inset = (PITCH - size) / 2;
  return { id: b.id, x0: b.x + inset, y0: b.y + inset, x1: b.x + inset + size, y1: b.y + inset + size };
}

/** Axis-aligned segments vs machine rects, 2px tolerance, endpoints exempt. */
function hitsBystander(segs: Seg[], rects: Rect[], a: string, b: string): boolean {
  for (const [ax, ay, bx, by] of segs) {
    const x0 = Math.min(ax, bx) - 2;
    const x1 = Math.max(ax, bx) + 2;
    const y0 = Math.min(ay, by) - 2;
    const y1 = Math.max(ay, by) + 2;
    for (const r of rects) {
      if (r.id === a || r.id === b) continue;
      if (x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0) return true;
    }
  }
  return false;
}

function segsOf(pts: [number, number][]): Seg[] {
  const out: Seg[] = [];
  for (let i = 1; i < pts.length; i++) {
    out.push([pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]]);
  }
  return out;
}

/** Total Manhattan length of an orthogonal polyline. */
function pathLen(pts: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
  }
  return total;
}

/** Side port with per-edge slot; pitch compresses onto small machines. */
function sidePort(rect: Rect, side: "out" | "in", k: number, n: number): [number, number] {
  const h = rect.y1 - rect.y0;
  const pitch = n > 1 ? Math.min(16, (h - 12) / (n - 1)) : 0;
  const cy = (rect.y0 + rect.y1) / 2 + (k - (n - 1) / 2) * pitch;
  return [side === "out" ? rect.x1 : rect.x0, Math.min(rect.y1 - 4, Math.max(rect.y0 + 4, cy))];
}

/** Slot offset from edge middle, for spreading parallel jogs (preview). */
function slotOffset(k: number, n: number, h: number): number {
  if (n <= 1) return 0;
  return (k - (n - 1) / 2) * Math.min(16, (h - 12) / (n - 1));
}

/** Short-hop corridor: straight H, H-V-H, or a +36 jog when running back. */
function shortCorridor(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  inOff: number,
): [number, number][] {
  if (x2 > x1 && Math.abs(y2 - y1) < 8) return [[x1, y1], [x2, y2]];
  if (x2 > x1) {
    const mx = Math.min(x2 - 1, Math.max(x1 + 1, (x1 + x2) / 2 + inOff * 0.25));
    return [
      [x1, y1],
      [mx, y1],
      [mx, y2],
      [x2, y2],
    ];
  }
  const jx = x1 + JOG_BACK;
  return [
    [x1, y1],
    [jx, y1],
    [jx, y2],
    [x2, y2],
  ];
}

/**
 * Short-hop candidates, cheapest first: the default corridor, jog
 * variants, then vertical detours through the inter-row gaps. First
 * clear route wins; when all are blocked the edge drops to the bus.
 * Detours keep same-zone hops short on dense floors instead of
 * flooding the bus band (the 1k-edge gate that motivated them).
 */
function shortCandidates(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  inOff: number,
): [number, number][][] {
  const out: [number, number][][] = [shortCorridor(x1, y1, x2, y2, inOff)];
  const detour = (jx: number, kx: number, d: number): [number, number][] => [
    [x1, y1],
    [jx, y1],
    [jx, y1 + d],
    [kx, y1 + d],
    [kx, y2],
    [x2, y2],
  ];
  if (x2 > x1) {
    for (const mx of [x1 + 8, x2 - 8]) {
      const c = Math.min(x2 - 1, Math.max(x1 + 1, mx));
      out.push([
        [x1, y1],
        [c, y1],
        [c, y2],
        [x2, y2],
      ]);
    }
    for (const d of [32, -32, 64, -64]) out.push(detour(x1 + 8, x2 - 8, d));
  } else {
    for (const jx of [x1 - 36, x1 + 68, x1 - 68]) {
      out.push([
        [x1, y1],
        [jx, y1],
        [jx, y2],
        [x2, y2],
      ]);
    }
    for (const d of [32, -32, 64, -64]) out.push(detour(x1 + JOG_BACK, x2 - 8, d));
  }
  return out;
}

/** First candidate clearing all bystanders (default when none do). */
function bestDirect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  inOff: number,
  rects: Rect[],
  a: string,
  b: string,
): [number, number][] {
  const cands = shortCandidates(x1, y1, x2, y2, inOff);
  for (const c of cands) {
    if (!hitsBystander(segsOf(c), rects, a, b)) return c;
  }
  return cands[0]!;
}

/** Chevron spots along an orthogonal polyline. */
function chevSpots(pts: [number, number][]): ChevronSpot[] {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
    lens.push(len);
    total += len;
  }
  if (total <= 0) return [];
  return CHEV_FRACS.map((f) => {
    let target = f * total;
    for (let i = 1; i < pts.length; i++) {
      if (target <= lens[i - 1]!) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        const angle = Math.atan2(by - ay, bx - ax);
        const len = lens[i - 1]!;
        const k = len > 0 ? target / len : 0;
        return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, angle };
      }
      target -= lens[i - 1]!;
    }
    const last = pts[pts.length - 1]!;
    return { x: last[0], y: last[1], angle: 0 };
  });
}

function pushTo(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Job index -> slot position, assigned at push time (O(1) lookups). */
function indexByJob(slots: Map<string, number[]>): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of slots.values()) list.forEach((job, k) => out.set(job, k));
  return out;
}

export function routeBelts(
  buildings: RoutableBuilding[],
  edges: RoutableEdge[],
  floorBottom: number,
): RouteResult {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const rects = buildings.map(machineRect);
  const rectById = new Map(rects.map((r) => [r.id, r]));

  type Job = { edge: RoutableEdge; from: RoutableBuilding; to: RoutableBuilding };
  const shorts: Job[] = [];
  const longs: Job[] = [];
  for (const edge of edges) {
    if (edge.fromId === edge.toId) continue;
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) continue;
    (Math.abs(from.zoneOrder - to.zoneOrder) >= LONG_HAUL_ZONE_GAP ? longs : shorts).push({ edge, from, to });
  }

  // Short hops first; corridors hitting a third machine drop to the bus.
  const outSlots = new Map<string, number[]>();
  const inSlots = new Map<string, number[]>();
  shorts.forEach((job, i) => {
    pushTo(outSlots, job.from.id, i);
    pushTo(inSlots, job.to.id, i);
  });
  const outSlot = indexByJob(outSlots);
  const inSlot = indexByJob(inSlots);
  const routes: RoutedPath[] = [];
  let overflow = 0;
  type BusJob = Job & { corridor?: [number, number][] };
  const busJobs: BusJob[] = longs.map((job) => ({ ...job }));
  shorts.forEach((job, i) => {
    const fr = rectById.get(job.from.id)!;
    const tr = rectById.get(job.to.id)!;
    const outs = outSlots.get(job.from.id)!;
    const ins = inSlots.get(job.to.id)!;
    const [x1, y1] = sidePort(fr, "out", outSlot.get(i)!, outs.length);
    const [x2, y2] = sidePort(tr, "in", inSlot.get(i)!, ins.length);
    const inOff = slotOffset(inSlot.get(i)!, ins.length, tr.y1 - tr.y0);
    const pts = bestDirect(x1, y1, x2, y2, inOff, rects, job.from.id, job.to.id);
    if (hitsBystander(segsOf(pts), rects, job.from.id, job.to.id)) {
      busJobs.push({ ...job, corridor: pts });
      return;
    }
    routes.push({ fromId: job.from.id, toId: job.to.id, pts, chev: chevSpots(pts), bus: false, lane: -1, overflow: false, len: pathLen(pts), key: job.edge.key });
  });

  // Bottom ports for bus riders, spread across the machine width.
  const touches = new Map<string, number[]>();
  busJobs.forEach((job, i) => {
    pushTo(touches, job.from.id, i);
    pushTo(touches, job.to.id, i);
  });
  const touchSlot = new Map<string, Map<number, number>>();
  for (const [id, list] of touches) touchSlot.set(id, new Map(list.map((job, k) => [job, k] as const)));
  const bottomPort = (id: string, jobIndex: number): [number, number] => {
    const r = rectById.get(id)!;
    const list = touches.get(id)!;
    const k = touchSlot.get(id)!.get(jobIndex)!;
    const n = list.length;
    const w = r.x1 - r.x0;
    const x = n > 1 ? r.x0 + 6 + (k * (w - 12)) / (n - 1) : (r.x0 + r.x1) / 2;
    return [Math.min(r.x1 - 3, Math.max(r.x0 + 3, x)), r.y1];
  };

  // Drop corridors to the deepest possible lane: clearance there
  // implies clearance to any shallower lane, so packing needs one pass.
  const deepLaneY = floorBottom + BUS_TOP_MARGIN + BUS_LANE_PITCH * (BUS_LANE_CAP - 1);
  const findDrop = (px: number, py: number, a: string, b: string): number | undefined => {
    for (const d of DROP_TRIES) {
      const dx = px + d;
      const segs: Seg[] =
        d === 0 ? [[px, py, dx, deepLaneY]] : [[px, py, dx, py], [dx, py, dx, deepLaneY]];
      if (!hitsBystander(segs, rects, a, b)) return dx;
    }
    return undefined;
  };
  type Span = { job: number; x0: number; x1: number; dx1: number; dx2: number };
  const spans: Span[] = [];
  busJobs.forEach((job, i) => {
    const [px1, py1] = bottomPort(job.from.id, i);
    const [px2, py2] = bottomPort(job.to.id, i);
    const dx1 = findDrop(px1, py1, job.from.id, job.to.id);
    const dx2 = findDrop(px2, py2, job.from.id, job.to.id);
    if (dx1 === undefined || dx2 === undefined) {
      // No clear corridor: direct orthogonal routing, counted so the
      // floor can say so on a plate.
      overflow++;
      const pts: [number, number][] =
        job.corridor ?? bestDirect(px1, py1, px2, py2, 0, rects, job.from.id, job.to.id);
      routes.push({ fromId: job.from.id, toId: job.to.id, pts, chev: chevSpots(pts), bus: false, lane: -1, overflow: true, len: pathLen(pts), key: job.edge.key });
      return;
    }
    spans.push({ job: i, x0: Math.min(dx1, dx2), x1: Math.max(dx1, dx2), dx1, dx2 });
  });

  // Interval-pack lanes; past the cap, direct routing + plate.
  const laneEnd: number[] = [];
  const laneOf = new Map<number, number>();
  const ordered = [...spans].sort((p, q) => p.x0 - q.x0 || p.x1 - q.x1 || p.job - q.job);
  for (const span of ordered) {
    let lane = laneEnd.findIndex((end) => end + BUS_LANE_PITCH <= span.x0);
    if (lane === -1) {
      if (laneEnd.length >= BUS_LANE_CAP) {
        overflow++;
        const job = busJobs[span.job]!;
        const [px1, py1] = bottomPort(job.from.id, span.job);
        const [px2, py2] = bottomPort(job.to.id, span.job);
        const pts: [number, number][] =
          job.corridor ?? bestDirect(px1, py1, px2, py2, 0, rects, job.from.id, job.to.id);
        routes.push({ fromId: job.from.id, toId: job.to.id, pts, chev: chevSpots(pts), bus: false, lane: -1, overflow: true, len: pathLen(pts), key: job.edge.key });
        continue;
      }
      lane = laneEnd.length;
      laneEnd.push(span.x1);
    } else {
      laneEnd[lane] = span.x1;
    }
    laneOf.set(span.job, lane);
  }
  for (const span of spans) {
    const lane = laneOf.get(span.job);
    if (lane === undefined) continue; // overflowed above
    const job = busJobs[span.job]!;
    const [px1, py1] = bottomPort(job.from.id, span.job);
    const [px2, py2] = bottomPort(job.to.id, span.job);
    const laneY = floorBottom + BUS_TOP_MARGIN + BUS_LANE_PITCH * lane;
    const pts: [number, number][] = [[px1, py1]];
    if (span.dx1 !== px1) pts.push([span.dx1, py1]);
    pts.push([span.dx1, laneY]);
    pts.push([span.dx2, laneY]);
    if (span.dx2 !== px2) pts.push([span.dx2, py2]);
    pts.push([px2, py2]);
    routes.push({ fromId: job.from.id, toId: job.to.id, pts, chev: chevSpots(pts), bus: true, lane, overflow: false, len: pathLen(pts), key: job.edge.key });
  }

  return {
    routes,
    lanes: laneEnd.length,
    overflow,
    busBottom: laneEnd.length > 0 ? floorBottom + BUS_TOP_MARGIN + BUS_LANE_PITCH * (laneEnd.length - 1) : floorBottom,
  };
}

/** Point-segment distance (zero-length segments read as points). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Closest routed path to a world point: minimum segment distance
 * wins, first route wins ties, nothing wins past maxDist.
 */
export function nearestRoute(
  routes: readonly RoutedPath[],
  x: number,
  y: number,
  maxDist: number,
): RoutedPath | undefined {
  let best: RoutedPath | undefined;
  let bestD = maxDist;
  for (const r of routes) {
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]!;
      const b = r.pts[i + 1]!;
      const d = segDist(x, y, a[0], a[1], b[0], b[1]);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
  }
  return best;
}
