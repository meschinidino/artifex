/**
 * Toaster story geometry (floor-native slice): where the four
 * stage machines, their belts, and the airlock gate live in world
 * coordinates. The story pad sits below the repo zones (the stage
 * in front of the factory), left-aligned with them, so the
 * existing landing is untouched and fit-all frames it for free.
 *
 * Pure: no DOM, no canvas. `app.ts` draws what this computes and
 * hit-tests with the same rects, so screen and model never drift.
 */
import { ZONE_GAP, ZONE_HEADER, type ZoneRect } from "./layout.ts";
import type { StageId, StageView, ToasterPanel } from "./toaster-view.ts";
import { caeProven } from "./toaster-ticker.ts";

export type WorldRect = { x: number; y: number; w: number; h: number };

/** Stage machine body size in world units (XL file band is 76). */
export const STAGE_SIZE = 96;
/** Slot pitch between stage machine origins. */
export const STAGE_PITCH = 148;
/** Airlock gate width at the pad's right edge. */
export const GATE_W = 168;
/** Gap between the last machine and the gate. */
export const GATE_GAP = 36;
/** Header room: Anton sign + the one-sentence story line. */
export const STORY_HEADER = ZONE_HEADER + 24;
/** Vertical room under a machine: job headline + lamp word + detail. */
export const STAGE_CAPTION_H = 92;

export type StageRect = WorldRect & { stage: StageView };

export type StoryLayout = {
  pad: WorldRect;
  stages: StageRect[];
  gate: WorldRect;
  /** Belt line height (machine centers). */
  beltY: number;
};

/** Story layout below the zones bbox; origin fallback when zoneless. */
export function storyLayout(zones: readonly ZoneRect[], panel: ToasterPanel): StoryLayout {
  const left = zones.length > 0 ? Math.min(...zones.map((z) => z.x)) : 0;
  const bottom = zones.length > 0 ? Math.max(...zones.map((z) => z.y + z.h)) : 0;
  const padW = STAGE_PITCH * 3 + STAGE_SIZE + GATE_GAP + GATE_W + 32;
  const pad: WorldRect = {
    x: left,
    y: bottom + ZONE_GAP,
    w: Math.max(padW, zones.length > 0 ? Math.min(...zones.map((z) => z.x + z.w)) - left : padW),
    h: STORY_HEADER + STAGE_SIZE + STAGE_CAPTION_H + 16,
  };
  const top = pad.y + STORY_HEADER + 8;
  const stages: StageRect[] = panel.stages.map((stage, i) => ({
    stage,
    x: pad.x + 16 + i * STAGE_PITCH,
    y: top,
    w: STAGE_SIZE,
    h: STAGE_SIZE,
  }));
  const gate: WorldRect = {
    x: pad.x + 16 + 3 * STAGE_PITCH + STAGE_SIZE + GATE_GAP,
    y: top,
    w: GATE_W,
    h: STAGE_SIZE,
  };
  return { pad, stages, gate, beltY: top + STAGE_SIZE / 2 };
}

/** Stage id at a world point, or undefined. Gate is not a stage. */
export function stageAtPoint(layout: StoryLayout, x: number, y: number): StageId | undefined {
  for (const r of layout.stages) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.stage.id;
  }
  return undefined;
}

/** True when the point is on the airlock gate. */
export function gateAtPoint(layout: StoryLayout, x: number, y: number): boolean {
  const g = layout.gate;
  return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
}

/**
 * Packet point at progress 0..1: rides machine centers from ASK
 * to PROVE, then crosses into the gate. Pure so the motion the
 * film shows is unit-pinned, not eyeballed.
 */
export function packetPoint(layout: StoryLayout, progress: number): { x: number; y: number } {
  const centers = layout.stages.map((r) => r.x + r.w / 2);
  const gateCx = layout.gate.x + layout.gate.w / 2;
  const stops = [...centers, gateCx];
  const clamped = Math.min(1, Math.max(0, progress));
  const span = stops.length - 1;
  const at = clamped * span;
  const i = Math.min(span - 1, Math.floor(at));
  const frac = at - i;
  return { x: stops[i]! + (stops[i + 1]! - stops[i]!) * frac, y: layout.beltY };
}

/** Packet rests at the gate once PROVE is proven; else at ASK. */
export function packetRestX(layout: StoryLayout, panel: ToasterPanel): number {
  return panel.latest && caeProven(panel.latest)
    ? layout.gate.x + layout.gate.w / 2
    : layout.stages[0]!.x + layout.stages[0]!.w / 2;
}
