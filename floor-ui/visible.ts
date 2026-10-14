/**
 * Render-set computation for the 1,000-block cap (design D10), pure so
 * the cap and the T4 selection exemption are unit-testable. Moved out
 * of app.ts unchanged except for the exemption and hidden counts.
 */
import type { ZoneRect } from "./layout.ts";
import type { Building } from "./wire.ts";

export const MAX_BLOCKS = 1_000;

function sortedZoneBuildings(zoneId: string, all: readonly Building[]): Building[] {
  return all
    .filter((b) => b.zoneId === zoneId)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

export type VisibleFloor = {
  zones: ZoneRect[];
  buildings: Building[];
  /** Rendered block count: capped at MAX_BLOCKS plus one exemption. */
  count: number;
  /** Per expanded zone, buildings cut that stay unrendered. */
  hiddenByZone: Map<string, number>;
};

/**
 * Apply the 1,000-block cap over zones in floor order: collapsed
 * zones cost one block for the pad, expanded zones fill to the cut.
 * The selected building is exempt — it always renders when its zone
 * is expanded, so search-and-jump can reach any machine past the
 * cut (T4 escape hatch). A collapsed zone never shows a lone
 * machine: its caption already covers the hidden set.
 */
export function computeVisible(args: {
  zones: readonly ZoneRect[];
  buildings: readonly Building[];
  expanded: ReadonlySet<string>;
  selectedPath?: string;
}): VisibleFloor {
  const { zones, buildings: all, expanded, selectedPath } = args;
  const buildings: Building[] = [];
  const visibleZones: ZoneRect[] = [];
  // Sorted once per zone per frame: hidden counts reuse the same
  // arrays instead of re-filtering all buildings per zone.
  const sortedByZone = new Map<string, Building[]>();
  let budget = MAX_BLOCKS;
  for (const zone of zones) {
    if (budget <= 0) break;
    visibleZones.push(zone);
    if (!expanded.has(zone.id)) {
      budget -= 1;
      continue;
    }
    const zbs = sortedZoneBuildings(zone.id, all);
    sortedByZone.set(zone.id, zbs);
    const take = Math.min(zbs.length, budget);
    buildings.push(...zbs.slice(0, take));
    budget -= take;
  }
  const renderedIds = new Set(buildings.map((b) => b.id));
  let exempted = 0;
  if (selectedPath !== undefined) {
    const selected = all.find((b) => b.path === selectedPath);
    if (selected && expanded.has(selected.zoneId) && !renderedIds.has(selected.id)) {
      const zone = zones.find((z) => z.id === selected.zoneId);
      if (zone && !visibleZones.includes(zone)) {
        // Late-added past an exhausted budget: register its sorted
        // set so the hidden count below covers it — a pad with one
        // machine and no hint would lie about the rest (FR7).
        visibleZones.push(zone);
        sortedByZone.set(zone.id, sortedZoneBuildings(zone.id, all));
      }
      buildings.push(selected);
      renderedIds.add(selected.id);
      exempted = 1;
    }
  }
  const hiddenByZone = new Map<string, number>();
  for (const [zoneId, zbs] of sortedByZone) {
    const hidden = zbs.reduce((n, b) => n + (renderedIds.has(b.id) ? 0 : 1), 0);
    if (hidden > 0) hiddenByZone.set(zoneId, hidden);
  }
  // Unchanged from the app.ts original: collapsed pads count as
  // one block each via the budget. The exempted selection is the
  // only way past the cap, by exactly one.
  return { zones: visibleZones, buildings, count: MAX_BLOCKS - budget + exempted, hiddenByZone };
}
