/**
 * Pure floor layout (T3a, issue #2; design D13 stability, D14 sizing).
 *
 * Each zone is a fixed-pitch grid inside its own vertical column.
 * Compaction policy (2026-10-18): a building's slot never moves
 * while it lives (D13 stability), but a slot freed by a delete or
 * a cross-zone rename is reused by the next assignment in that
 * zone (lowest free slot wins), so create/delete churn cannot
 * exile buildings down an ever-longer pad. Zone columns
 * themselves are reclaimed only by an explicit relayout. A file
 * crossing into a bigger size band grows inside its own slot.
 * No I/O here: the server persists FloorLayout to
 * .artifex/floor-state.json.
 */

export const LAYOUT_VERSION = 1;

/** Stepped footprint bands by line count (design D14). */
export const LINE_BANDS = [100, 500, 2000] as const;
/** Binary files map into the same four bands by bytes. */
export const BYTE_BANDS = [10_000, 100_000, 1_000_000] as const;
/** Rendered square size per band, in world units. */
export const BAND_SIZES = [28, 40, 56, 76] as const;
/** Slot pitch: largest footprint plus gap, so growth never overlaps. */
export const PITCH = 96;
/** Vertical space reserved above a zone grid for its name. */
export const ZONE_HEADER = 40;
/** Horizontal gap between zone columns. */
export const ZONE_GAP = 48;

export type Band = 0 | 1 | 2 | 3;

export function bandForFile(lines: number, bytes: number, binary: boolean): Band {
  if (binary) {
    if (bytes < BYTE_BANDS[0]) return 0;
    if (bytes < BYTE_BANDS[1]) return 1;
    if (bytes < BYTE_BANDS[2]) return 2;
    return 3;
  }
  if (lines < LINE_BANDS[0]) return 0;
  if (lines < LINE_BANDS[1]) return 1;
  if (lines < LINE_BANDS[2]) return 2;
  return 3;
}

export const ROOT_ZONE = "(root)";

/** Zone of a file: its top-level folder, or the root zone. */
export function zoneOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? ROOT_ZONE : path.slice(0, slash);
}

export type ZoneLayout = {
  /** World x of the zone column. */
  x: number;
  /** Grid columns, fixed when the zone is created. */
  cols: number;
  /** High-water mark: one past the largest slot ever assigned. Freed slots below it are reused first. */
  nextSlot: number;
};

export type BuildingLayout = {
  id: string;
  zoneId: string;
  slot: number;
  x: number;
  y: number;
};

export type FloorLayout = {
  v: typeof LAYOUT_VERSION;
  zones: Record<string, ZoneLayout>;
  buildings: Record<string, BuildingLayout>;
  /** Append cursor for new zone columns. */
  nextZoneX: number;
  /** Monotonic counter minting stable building ids. */
  nextId: number;
};

export function createFloorLayout(): FloorLayout {
  // Null-prototype records: keys are folder/file names from disk, and
  // names like "constructor" or "__proto__" must be plain data keys.
  return {
    v: LAYOUT_VERSION,
    zones: Object.create(null) as Record<string, ZoneLayout>,
    buildings: Object.create(null) as Record<string, BuildingLayout>,
    nextZoneX: 0,
    nextId: 1,
  };
}

function colsForCount(count: number): number {
  return Math.min(16, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count)))));
}

function slotXY(zone: ZoneLayout, slot: number): { x: number; y: number } {
  const col = slot % zone.cols;
  const row = Math.floor(slot / zone.cols);
  return { x: zone.x + col * PITCH, y: ZONE_HEADER + row * PITCH };
}

function ensureZone(layout: FloorLayout, zoneId: string, initialCount: number): ZoneLayout {
  let zone = layout.zones[zoneId];
  if (!zone) {
    zone = { x: layout.nextZoneX, cols: colsForCount(initialCount), nextSlot: 0 };
    layout.zones[zoneId] = zone;
    layout.nextZoneX += zone.cols * PITCH + ZONE_GAP;
  }
  return zone;
}

/**
 * Lowest slot in the zone no living building occupies. Derived
 * from the buildings record on each assignment — no persisted
 * free list to keep in sync, and gaps in layouts persisted by
 * older versions are reclaimed the same way.
 */
function firstFreeSlot(layout: FloorLayout, zoneId: string): number {
  const used = new Set<number>();
  for (const b of Object.values(layout.buildings)) {
    if (b.zoneId === zoneId) used.add(b.slot);
  }
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/**
 * Assign a slot to a building, keeping its id when it already exists
 * (cross-zone rename takes a fresh slot in the destination zone).
 * Returns the placement. Existing same-zone buildings return as-is.
 */
export function assignBuilding(
  layout: FloorLayout,
  path: string,
  opts: { existingId?: string; zoneInitialCount?: number } = {},
): BuildingLayout {
  const zoneId = zoneOf(path);
  const current = layout.buildings[path];
  if (current && current.zoneId === zoneId) return current;
  const zone = ensureZone(layout, zoneId, opts.zoneInitialCount ?? 1);
  const slot = firstFreeSlot(layout, zoneId);
  if (slot >= zone.nextSlot) zone.nextSlot = slot + 1;
  const { x, y } = slotXY(zone, slot);
  const placed: BuildingLayout = {
    id: opts.existingId ?? current?.id ?? `b${layout.nextId++}`,
    zoneId,
    slot,
    x,
    y,
  };
  layout.buildings[path] = placed;
  return placed;
}

export function removeBuilding(layout: FloorLayout, path: string): void {
  delete layout.buildings[path];
}

/**
 * Move a building to a new path, keeping id and slot when the zone
 * does not change; cross-zone renames take an append slot in the
 * destination zone (zone membership wins). Returns the placement.
 */
export function renameBuilding(
  layout: FloorLayout,
  fromPath: string,
  toPath: string,
  opts: { zoneInitialCount?: number } = {},
): BuildingLayout | undefined {
  const current = layout.buildings[fromPath];
  if (!current) return undefined;
  delete layout.buildings[fromPath];
  // An occupied target (overwrite-rename, case-only rename on a
  // case-insensitive FS) must not be silently clobbered: evict it so
  // the displaced path is reassigned on its own event instead of
  // vanishing from the floor with the mover's id on its slot.
  delete layout.buildings[toPath];
  if (zoneOf(toPath) === current.zoneId) {
    layout.buildings[toPath] = current;
    return current;
  }
  return assignBuilding(layout, toPath, { existingId: current.id, zoneInitialCount: opts.zoneInitialCount });
}

export type ZoneRect = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fileCount: number;
};

/** Zone rectangles for rendering, ordered by zone name. */
export function zoneRects(layout: FloorLayout): ZoneRect[] {
  const counts = new Map<string, number>();
  const maxSlot = new Map<string, number>();
  for (const b of Object.values(layout.buildings)) {
    counts.set(b.zoneId, (counts.get(b.zoneId) ?? 0) + 1);
    maxSlot.set(b.zoneId, Math.max(maxSlot.get(b.zoneId) ?? 0, b.slot));
  }
  return Object.keys(layout.zones)
    .sort()
    .map((name) => {
      const zone = layout.zones[name]!;
      const rows = Math.floor((maxSlot.get(name) ?? 0) / zone.cols) + 1;
      return {
        id: name,
        name,
        x: zone.x - 12,
        y: 0,
        w: zone.cols * PITCH + 24,
        h: ZONE_HEADER + rows * PITCH + 12,
        fileCount: counts.get(name) ?? 0,
      };
    });
}

/**
 * Zone under a world point: smallest containing area wins
 * (deterministic under overlap); undefined when none contains it.
 */
export function zoneAtPoint(zones: readonly ZoneRect[], x: number, y: number): ZoneRect | undefined {
  let best: ZoneRect | undefined;
  for (const z of zones) {
    if (x < z.x || x > z.x + z.w || y < z.y || y > z.y + z.h) continue;
    if (best === undefined || z.w * z.h < best.w * best.h) best = z;
  }
  return best;
}

/**
 * Deterministic bulk layout for first boot and explicit relayout:
 * zones by name, files by path, columns sized from content. Ids are
 * preserved from `previous` when a path already has one.
 */
export function layoutFloor(
  paths: readonly string[],
  previous?: FloorLayout,
): FloorLayout {
  const layout = createFloorLayout();
  layout.nextId = previous?.nextId ?? 1;
  const byZone = new Map<string, string[]>();
  for (const path of [...paths].sort()) {
    const z = zoneOf(path);
    const list = byZone.get(z) ?? [];
    list.push(path);
    byZone.set(z, list);
  }
  for (const zoneId of [...byZone.keys()].sort()) {
    const files = byZone.get(zoneId)!;
    ensureZone(layout, zoneId, files.length);
    for (const path of files) {
      assignBuilding(layout, path, {
        existingId: previous?.buildings[path]?.id,
        zoneInitialCount: files.length,
      });
    }
  }
  return layout;
}

