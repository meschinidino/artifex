/**
 * Viewport, zoom, and pick math (coverage slice 2).
 *
 * Pure: the camera is an explicit value in and out; `app.ts` owns the
 * live instance and applies what these return. Tests assert geometric
 * invariants (containment, anchor preservation, round-trips), never
 * copies of the arithmetic.
 */
import { PITCH, type ZoneRect } from "./layout.ts";
import { newestBuilding } from "./machines.ts";
import type { Building } from "./wire.ts";

export type Camera = { x: number; y: number; scale: number };
export type ViewBox = { x: number; y: number; w: number; h: number };

export type ZoomBandName = "far" | "mid" | "near";

export function zoomBand(scale: number): ZoomBandName {
  if (scale < 0.5) return "far";
  if (scale <= 1.25) return "mid";
  return "near";
}

/** World rect currently visible through the viewport. */
export function worldViewport(cam: Camera, w: number, h: number): ViewBox {
  return {
    x: -cam.x / cam.scale,
    y: -cam.y / cam.scale,
    w: w / cam.scale,
    h: h / cam.scale,
  };
}

/**
 * Fit-all camera: frames every zone plus the bus band (and its
 * overflow plate when lit), scale capped at 1, origin at top-left.
 * Undefined when there is nothing to frame.
 */
export function fitCameraState(
  w: number,
  h: number,
  zones: readonly ZoneRect[],
  busBottom: number,
  overflow: number,
): Camera | undefined {
  if (zones.length === 0 || w === 0) return undefined;
  const right = Math.max(...zones.map((z) => z.x + z.w));
  const bottom = Math.max(...zones.map((z) => z.y + z.h), busBottom + (overflow > 0 ? 48 : 0));
  return { x: 0, y: 0, scale: Math.min(1, w / (right + 24), h / (bottom + 24)) };
}

export type Landing = { scale: number; x: number; y: number; zoneId: string; lastChange?: { text: string; ts: number } };

/**
 * First-run landing: close on the newest file's pad, that pad
 * expanded. Scale clamps to [0.3, 1]; undefined when unframeable.
 * Mtimes arrive with the buildings (no clock reads).
 */
export function computeLanding(
  zones: readonly ZoneRect[],
  buildings: Iterable<Building>,
  w: number,
  h: number,
): Landing | undefined {
  if (zones.length === 0 || w === 0) return undefined;
  const newest = newestBuilding(buildings);
  const zone = zones.find((z) => z.id === newest?.zoneId) ?? zones[0]!;
  const scale = Math.min(1, Math.max(0.3, Math.min(w / (zone.w + 220), h / (zone.h + 220))));
  return {
    scale,
    x: w / 2 - (zone.x + zone.w / 2) * scale,
    y: Math.min(24, h / 2 - (zone.y + zone.h / 2) * scale) + 12,
    zoneId: zone.id,
    ...(newest ? { lastChange: { text: newest.path, ts: newest.mtimeMs } } : {}),
  };
}

/** Camera centered on a building's slot center. */
export function centerOnBuilding(cam: Camera, w: number, h: number, bx: number, by: number): Camera {
  return {
    x: w / 2 - (bx + PITCH / 2) * cam.scale,
    y: h / 2 - (by + PITCH / 2) * cam.scale,
    scale: cam.scale,
  };
}

/** Search-jump zoom floor: never below 1.5x, never above 4x. */
export function jumpScale(scale: number): number {
  return Math.min(4, Math.max(scale, 1.5));
}

export type Pick = { x: number; y: number; sx: number; sy: number };

/**
 * Client point → world point. (rx, ry) is the canvas-box origin;
 * pass 0,0 for viewport-relative points (step zoom around center).
 */
export function toWorldPoint(cam: Camera, rx: number, ry: number, clientX: number, clientY: number): Pick {
  const sx = clientX - rx;
  const sy = clientY - ry;
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale, sx, sy };
}

/** Wheel/trackpad zoom factor: scroll-up (negative deltaY) zooms in. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015);
}

/** Zoom clamp shared by wheel and step zoom. */
export function clampZoom(scale: number): number {
  return Math.min(4, Math.max(0.05, scale));
}

/**
 * Re-aim the camera at a new scale keeping the anchor fixed: the
 * world point under (sx, sy) is identical before and after.
 */
export function zoomAround(cam: Camera, sx: number, sy: number, wx: number, wy: number, next: number): Camera {
  return { x: sx - wx * next, y: sy - wy * next, scale: next };
}

/** Segment-vs-view cull; edge-touching counts as visible (no pop-out). */
export function segmentVisible(ax: number, ay: number, bx: number, by: number, view: ViewBox): boolean {
  return !(
    Math.max(ax, bx) < view.x ||
    Math.min(ax, bx) > view.x + view.w ||
    Math.max(ay, by) < view.y ||
    Math.min(ay, by) > view.y + view.h
  );
}

/** Bounding box of a point list (belt-path cull input). */
export function bboxOfPts(pts: readonly (readonly [number, number])[]): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of pts) {
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Box-vs-view cull shared by belt paths (over their bbox) and
 * machines (over the slot footprint). Strict inequalities: touching
 * the view edge still draws.
 */
export function boxVisible(x0: number, y0: number, x1: number, y1: number, view: ViewBox): boolean {
  return !(x1 < view.x || x0 > view.x + view.w || y1 < view.y || y0 > view.y + view.h);
}

/** Minimap fit: the binding dimension wins. */
export function minimapScale(width: number, height: number, right: number, bottom: number): number {
  return Math.min(width / right, height / bottom);
}
