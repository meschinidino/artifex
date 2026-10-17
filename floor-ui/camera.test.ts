/**
 * Slice 2: viewport, zoom, and pick math. Invariants over formula
 * copies: containment, anchor preservation, round-trips, clamps.
 */
import { describe, expect, test } from "bun:test";
import {
  bboxOfPts,
  boxVisible,
  centerOnBuilding,
  clampZoom,
  computeLanding,
  fitCameraState,
  jumpScale,
  minimapScale,
  segmentVisible,
  toWorldPoint,
  wheelFactor,
  worldViewport,
  zoomAround,
  zoomBand,
  type Camera,
  type ViewBox,
} from "./camera.ts";
import { PITCH, type ZoneRect } from "./layout.ts";
import type { Building } from "./wire.ts";

function zone(over: Partial<ZoneRect> = {}): ZoneRect {
  return { id: "z1", name: "z1", x: 0, y: 0, w: 400, h: 300, fileCount: 3, ...over };
}

function building(over: Partial<Building> = {}): Building {
  return {
    id: "b1",
    path: "a.ts",
    zoneId: "z1",
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

/** Every point of every zone plus the bus plate sits inside the view. */
function expectContainsView(cam: Camera, w: number, h: number, zones: ZoneRect[], mustReachY: number) {
  const vw = w / cam.scale;
  const vh = h / cam.scale;
  for (const z of zones) {
    expect(-cam.x / cam.scale).toBeLessThanOrEqual(z.x);
    expect(-cam.y / cam.scale).toBeLessThanOrEqual(z.y);
    expect(z.x + z.w).toBeLessThanOrEqual(-cam.x / cam.scale + vw + 1e-9);
    expect(z.y + z.h).toBeLessThanOrEqual(-cam.y / cam.scale + vh + 1e-9);
  }
  expect(mustReachY).toBeLessThanOrEqual(-cam.y / cam.scale + vh + 1e-9);
}

describe("zoomBand", () => {
  // Value: protects=far/mid/near render gating; fails_when=a
  // threshold drifts (belts/nameplates flip bands at the wrong zoom);
  // why_new=Slice 2; seam=none.
  test("boundaries 0.5 and 1.25", () => {
    expect(zoomBand(0.49)).toBe("far");
    expect(zoomBand(0.5)).toBe("mid");
    expect(zoomBand(1.25)).toBe("mid");
    expect(zoomBand(1.26)).toBe("near");
  });
});

describe("worldViewport", () => {
  // Value: protects=cull-rect math (what the frame considers
  // visible); fails_when=sign/scale errors shift culling (pop-in);
  // why_new=Slice 2; seam=none.
  test("inverts the camera transform", () => {
    const cam: Camera = { x: 100, y: 50, scale: 2 };
    expect(worldViewport(cam, 800, 600)).toEqual({ x: -50, y: -25, w: 400, h: 300 });
  });
});

describe("fitCameraState", () => {
  // Value: protects=fit-all framing the whole floor incl. the bus
  // band + overflow plate; fails_when=bottom math drops the bus terms
  // (fit-all crops live belts); why_new=Slice 2 (consumer side of the
  // busBottom contract route.test.ts pins); seam=none.
  test("contains zones, bus band, and the overflow plate", () => {
    const zones = [zone({ id: "a", x: 0, y: 0, w: 500, h: 400 }), zone({ id: "b", x: 600, y: 100, w: 300, h: 200 })];
    const plain = fitCameraState(800, 600, zones, 700, 0)!;
    expect(plain.scale).toBeLessThan(1);
    expectContainsView(plain, 800, 600, zones, 700);
    const lit = fitCameraState(800, 600, zones, 700, 3)!;
    expectContainsView(lit, 800, 600, zones, 748);
    // The plate costs pixels: lighting it strictly zooms out.
    expect(lit.scale).toBeLessThan(plain.scale);
  });

  // Value: protects=fit-all on empty/unmeasurable floors;
  // fails_when=the guard drops (Math.max of nothing → -Infinity
  // camera); why_new=Slice 2; seam=none.
  test("empty zones or zero width decline", () => {
    expect(fitCameraState(1440, 900, [], 0, 0)).toBeUndefined();
    expect(fitCameraState(0, 900, [zone()], 0, 0)).toBeUndefined();
  });
});

describe("computeLanding", () => {
  // Value: protects=first-run landing on the newest pad, expanded;
  // fails_when=zone choice or scale clamp drifts (landing on stale
  // code, or a 0.01/50x scale); why_new=Slice 2 + A4/A8; seam=none.
  test("lands on the newest zone with clamped scale", () => {
    const zones = [
      zone({ id: "old", x: 0, y: 0, w: 400, h: 300 }),
      zone({ id: "new", x: 1000, y: 0, w: 400, h: 300 }),
    ];
    const bs = [building({ zoneId: "old", mtimeMs: 100 }), building({ path: "n.ts", zoneId: "new", mtimeMs: 999 })];
    const c = computeLanding(zones, bs, 1440, 900)!;
    expect(c.zoneId).toBe("new");
    expect(c.scale).toBeGreaterThanOrEqual(0.3);
    expect(c.scale).toBeLessThanOrEqual(1);
    expect(c.lastChange).toEqual({ text: "n.ts", ts: 999 });
    // The landed-on zone's center sits at the viewport center x.
    expect(c.x + (1000 + 200) * c.scale).toBeCloseTo(720, 9);
  });

  // Value: protects=landing clamps at viewport extremes + degenerate
  // inputs; fails_when=clamp bounds drift; why_new=Slice 2; seam=none.
  test("tiny viewports pin 0.3, huge pin 1, degenerate inputs decline", () => {
    const zones = [zone({ w: 400, h: 300 })];
    expect(computeLanding(zones, [], 100, 100)!.scale).toBe(0.3);
    expect(computeLanding(zones, [], 100000, 100000)!.scale).toBe(1);
    expect(computeLanding([], [], 1440, 900)).toBeUndefined();
    expect(computeLanding(zones, [], 0, 900)).toBeUndefined();
    // No buildings: first zone, no last-change.
    const c = computeLanding(zones, [], 1440, 900)!;
    expect(c.zoneId).toBe("z1");
    expect(c.lastChange).toBeUndefined();
  });
});

describe("centerOnBuilding + toWorldPoint", () => {
  // Value: protects=search-jump/follow centering on the machine;
  // fails_when=center math drifts (jumps land off-machine);
  // why_new=Slice 2; seam=none.
  test("machine center maps to viewport center (round-trip)", () => {
    const cam: Camera = { x: 33, y: -12, scale: 1.5 };
    const centered = centerOnBuilding(cam, 1440, 900, 200, 96);
    expect(centered.scale).toBe(1.5);
    const p = toWorldPoint(centered, 0, 0, 720, 450);
    expect(p.x).toBeCloseTo(200 + PITCH / 2, 9);
    expect(p.y).toBeCloseTo(96 + PITCH / 2, 9);
  });

  // Value: protects=pointer→world pick math incl. canvas offset;
  // fails_when=rect subtraction drops (clicks hit-test offset
  // machines); why_new=Slice 2; seam=none.
  test("known pick values with a canvas offset", () => {
    const p = toWorldPoint({ x: 10, y: 20, scale: 2 }, 5, 5, 25, 35);
    expect(p).toEqual({ x: 5, y: 5, sx: 20, sy: 30 });
  });
});

describe("jumpScale", () => {
  // Value: protects=search-jump zoom floor/ceiling; fails_when=the
  // 1.5 floor drops (jumps land unreadably far); why_new=Slice 2.
  test("clamps into [1.5, 4]", () => {
    expect(jumpScale(0.05)).toBe(1.5);
    expect(jumpScale(1)).toBe(1.5);
    expect(jumpScale(2)).toBe(2);
    expect(jumpScale(9)).toBe(4);
  });
});

describe("wheel + step zoom core", () => {
  // Value: protects=scroll direction; fails_when=the sign flips
  // (scroll-up zooms out — instant user rage); why_new=Slice 2.
  test("scroll-up zooms in, scroll-down zooms out, still is 1", () => {
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
  });

  // Value: protects=shared zoom clamp; fails_when=wheel/step clamps
  // diverge (one path escapes to 0/inf scale); why_new=Slice 2.
  test("clamp pins at 0.05 and 4", () => {
    expect(clampZoom(0.01)).toBe(0.05);
    expect(clampZoom(99)).toBe(4);
    expect(clampZoom(1)).toBe(1);
  });

  // Value: protects=cursor-anchored zoom (the point under the cursor
  // stays put); fails_when=anchor math drifts (zooming slides the
  // floor away); why_new=Slice 2; seam=none.
  test("zoomAround preserves the world point under the cursor", () => {
    const cases: { cam: Camera; sx: number; sy: number; next: number }[] = [
      { cam: { x: 0, y: 0, scale: 1 }, sx: 720, sy: 450, next: 2 },
      { cam: { x: -300, y: 120, scale: 0.5 }, sx: 100, sy: 800, next: 0.35 },
      { cam: { x: 44, y: -9, scale: 3 }, sx: 1400, sy: 12, next: 4 },
    ];
    for (const { cam, sx, sy, next } of cases) {
      const before = toWorldPoint(cam, 0, 0, sx, sy);
      const after = zoomAround(cam, sx, sy, before.x, before.y, next);
      const check = toWorldPoint(after, 0, 0, sx, sy);
      expect(check.x).toBeCloseTo(before.x, 9);
      expect(check.y).toBeCloseTo(before.y, 9);
      expect(after.scale).toBe(next);
    }
  });
});

describe("culling", () => {
  const view: ViewBox = { x: 0, y: 0, w: 100, h: 100 };

  // Value: protects=segment culling without 1px pop-out;
  // fails_when=strictness flips (visible belts vanish at the edge);
  // why_new=Slice 2; seam=none.
  test("segmentVisible keeps edge-touching segments", () => {
    expect(segmentVisible(10, 10, 20, 20, view)).toBe(true);
    expect(segmentVisible(-50, -50, -10, -10, view)).toBe(false);
    expect(segmentVisible(-50, 50, 0, 50, view)).toBe(true);
    expect(segmentVisible(100, 0, 150, 50, view)).toBe(true);
    expect(segmentVisible(0, 100, 50, 150, view)).toBe(true);
  });

  // Value: protects=belt-path + machine culling consensus;
  // fails_when=bbox and segment culls disagree (belts drawn for
  // culled machines or vice versa); why_new=Slice 2; seam=none.
  test("bboxOfPts + boxVisible agree with segmentVisible", () => {
    const pts = [
      [10, 10],
      [20, 30],
      [15, 25],
    ] as const;
    const bb = bboxOfPts(pts.map(([x, y]) => [x, y] as [number, number]));
    expect(bb).toEqual({ x0: 10, y0: 10, x1: 20, y1: 30 });
    expect(boxVisible(bb.x0, bb.y0, bb.x1, bb.y1, view)).toBe(true);
    expect(boxVisible(200, 200, 300, 300, view)).toBe(false);
    // Machine-slot footprint uses the same predicate.
    expect(boxVisible(10, 10, 10 + PITCH, 10 + PITCH, view)).toBe(true);
    expect(boxVisible(-200, -200, -200 + PITCH, -200 + PITCH, view)).toBe(false);
  });
});

describe("minimapScale", () => {
  // Value: protects=site-plan fit; fails_when=the binding dimension
  // flips (plan crops or floats); why_new=Slice 2; seam=none.
  test("the binding dimension wins", () => {
    expect(minimapScale(180, 120, 900, 1200)).toBe(0.1);
    expect(minimapScale(180, 120, 1800, 600)).toBe(0.1);
    expect(minimapScale(180, 120, 1800, 1200)).toBe(0.1);
  });
});
