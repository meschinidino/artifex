/**
 * Belt derived data + classification (coverage slice 3).
 *
 * Pure: degree maps, zone aggregates, reroute/coalesce/degrade
 * predicates, route and rollup classifiers, tick budgets. `app.ts`
 * owns the cache object, the coalesce timer, and every canvas stroke.
 */
import { bboxOfPts, boxVisible, segmentVisible, type ViewBox } from "./camera.ts";
import type { ZoneRect } from "./layout.ts";
import type { RoutableBuilding, RoutedPath } from "./route.ts";
import type { BeltEdge, Building } from "./wire.ts";

/** Patch bursts re-route at most this often; a catch-up frame follows. */
export const ROUTE_MIN_INTERVAL = 250;
/** Route passes slower than this trip the chevron/tick degrade. */
export const ROUTE_DEGRADE_MS = 50;
/** Degrade clears only below this: no flicker at the boundary. */
export const ROUTE_RECOVER_MS = 35;
/** Item-tick spacing along a live belt (world units). */
export const TICK_SPACING = 64;
/** Item ticks per belt, and total per frame. */
export const TICKS_PER_ROUTE = 3;
export const TICK_CAP = 48;

export type Degrees = {
  byId: Map<string, Building>;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
};

/**
 * Fan-in/fan-out over resolved edges; edges touching unknown
 * buildings are skipped (cap-cut or mid-patch phantoms).
 */
export function countDegrees(buildings: Iterable<Building>, belts: Iterable<BeltEdge>): Degrees {
  const byId = new Map<string, Building>();
  for (const b of buildings) byId.set(b.id, b);
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const e of belts) {
    if (!byId.get(e.fromId) || !byId.get(e.toId)) continue;
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
    outDegree.set(e.fromId, (outDegree.get(e.fromId) ?? 0) + 1);
  }
  return { byId, inDegree, outDegree };
}

/** Pip count per building id: max of fan-in/fan-out, cap 5. */
export function countPips(inDegree: Map<string, number>, outDegree: Map<string, number>): Map<string, number> {
  const pipCounts = new Map<string, number>();
  for (const [id, n] of inDegree) pipCounts.set(id, Math.min(5, n));
  for (const [id, n] of outDegree) pipCounts.set(id, Math.min(5, Math.max(n, pipCounts.get(id) ?? 0)));
  return pipCounts;
}

export type ZoneAggregate = { a: string; b: string; count: number };

/**
 * Cross-zone pair counts for the far-band rollup. Same-zone pairs
 * never aggregate; pairs are directional (a→b and b→a stay split).
 */
export function aggregateZones(byId: Map<string, Building>, belts: Iterable<BeltEdge>): ZoneAggregate[] {
  const counts = new Map<string, number>();
  for (const e of belts) {
    const from = byId.get(e.fromId);
    const to = byId.get(e.toId);
    if (!from || !to) continue;
    if (from.zoneId === to.zoneId) continue;
    const key = `${from.zoneId}\0${to.zoneId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [a, b] = key.split("\0") as [string, string];
    return { a, b, count };
  });
}

/**
 * Reroute guard: version move OR belts-array identity change. The
 * identity leg catches reconnects — a restarted server reuses
 * version numbers with different content.
 */
export function needsReroute(
  cached: { version: number; belts: BeltEdge[] } | undefined,
  version: number,
  belts: BeltEdge[],
): boolean {
  return !cached || cached.version !== version || cached.belts !== belts;
}

/** Patch-burst coalescing: re-route at most every 250 ms. */
export function shouldCoalesce(lastRouteAt: number, nowMs: number): boolean {
  return nowMs - lastRouteAt < ROUTE_MIN_INTERVAL;
}

/**
 * Degrade hysteresis: trip above 50 ms, clear below 35 ms, hold the
 * previous state between (no chevron flicker at the boundary).
 */
export function degradeStep(routeMs: number, wasDegraded: boolean): boolean {
  if (routeMs > ROUTE_DEGRADE_MS) return true;
  if (routeMs < ROUTE_RECOVER_MS) return false;
  return wasDegraded;
}

export type RoutableFloor = { list: RoutableBuilding[]; floorBottom: number };

/**
 * Router input: per-building zone order (unknown zones sort first)
 * plus the floor bottom the bus band hangs below.
 */
export function routableBuildings(
  buildings: Iterable<Building>,
  zones: readonly ZoneRect[],
): RoutableFloor {
  const zoneOrder = new Map(zones.map((z, i) => [z.id, i]));
  const list = [...buildings].map((b) => ({
    id: b.id,
    zoneOrder: zoneOrder.get(b.zoneId) ?? 0,
    x: b.x,
    y: b.y,
    band: b.band,
  }));
  const floorBottom = zones.length > 0 ? Math.max(...zones.map((z) => z.y + z.h)) : 0;
  return { list, floorBottom };
}

export type ClassifiedRoutes = {
  live: RoutedPath[];
  struct: RoutedPath[];
  dimmed: RoutedPath[];
  drawn: number;
  endpoints: [string, string][];
};

/**
 * Mid/near route classifier: unknown endpoints drop first, then the
 * rendered-set gate (skipped for incident routes under a selection,
 * so a selection spotlights its full neighborhood even to
 * unrendered targets), then the view cull, then incident/dimmed by
 * selection, then live/struct by pulse. Drawn counts only incident
 * routes.
 */
export function classifyRoutes(
  routes: readonly RoutedPath[],
  byId: Map<string, Building>,
  visibleIds: Set<string>,
  isolatedId: string | undefined,
  pulsedIds: Set<string>,
  view: ViewBox,
): ClassifiedRoutes {
  const live: RoutedPath[] = [];
  const struct: RoutedPath[] = [];
  const dimmed: RoutedPath[] = [];
  const endpoints: [string, string][] = [];
  let drawn = 0;
  for (const r of routes) {
    const from = byId.get(r.fromId);
    const to = byId.get(r.toId);
    if (!from || !to) continue;
    const selected = isolatedId !== undefined && (r.fromId === isolatedId || r.toId === isolatedId);
    if (!selected && (!visibleIds.has(from.id) || !visibleIds.has(to.id))) continue;
    const bb = bboxOfPts(r.pts);
    if (!boxVisible(bb.x0, bb.y0, bb.x1, bb.y1, view)) continue;
    if (!selected && isolatedId !== undefined) {
      dimmed.push(r);
      continue;
    }
    drawn++;
    endpoints.push([r.fromId, r.toId]);
    (pulsedIds.has(r.fromId) || pulsedIds.has(r.toId) ? live : struct).push(r);
  }
  return { live, struct, dimmed, drawn, endpoints };
}

export type RollupBucket = { min: number; max: number; width: number };

/** Far-band width buckets: thin/mid/wide by pair count. */
export const ROLLUP_BUCKETS: readonly RollupBucket[] = [
  { min: 1, max: 2, width: 1.75 },
  { min: 3, max: 8, width: 4 },
  { min: 9, max: Infinity, width: 6 },
];

export type RollupLane = { width: number; live: boolean; aggs: ZoneAggregate[] };

/**
 * Far-band rollup classifier: each aggregate lands in one width
 * bucket as live (touches a pulsed or selected zone) or steel.
 * Selection narrows to pairs touching its zone; pairs with a
 * missing zone or outside the view drop.
 */
export function classifyAggregates(
  aggregates: readonly ZoneAggregate[],
  zoneById: Map<string, ZoneRect>,
  pulsedZones: Set<string>,
  isolatedZone: string | undefined,
  view: ViewBox,
): RollupLane[] {
  const lanes: RollupLane[] = [];
  for (const { min, max, width } of ROLLUP_BUCKETS) {
    for (const live of [true, false] as const) {
      const aggs: ZoneAggregate[] = [];
      for (const agg of aggregates) {
        if (agg.count < min || agg.count > max) continue;
        if (isolatedZone !== undefined && agg.a !== isolatedZone && agg.b !== isolatedZone) continue;
        const za = zoneById.get(agg.a);
        const zb = zoneById.get(agg.b);
        if (!za || !zb) continue;
        const pairLive =
          pulsedZones.has(agg.a) ||
          pulsedZones.has(agg.b) ||
          (isolatedZone !== undefined && (agg.a === isolatedZone || agg.b === isolatedZone));
        if (pairLive !== live) continue;
        const ax = za.x + za.w / 2;
        const ay = za.y + za.h / 2;
        const bx = zb.x + zb.w / 2;
        const by = zb.y + zb.h / 2;
        if (!segmentVisible(ax, ay, bx, by, view)) continue;
        aggs.push(agg);
      }
      lanes.push({ width, live, aggs });
    }
  }
  return lanes;
}

/**
 * Item-tick budgets per live belt: min(3, len/64) each, 48 total per
 * frame — later belts starve once the cap binds. Positions come from
 * pointAt (Slice 1) at draw time.
 */
export function tickCounts(lens: readonly number[]): number[] {
  const out: number[] = [];
  let items = 0;
  for (const len of lens) {
    const n = Math.min(TICKS_PER_ROUTE, Math.floor(len / TICK_SPACING));
    const take = Math.min(n, TICK_CAP - items);
    out.push(take);
    items += take;
  }
  return out;
}
