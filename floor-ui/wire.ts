/**
 * Server<->floor-ui wire protocol v1 (T3a, issue #2). One definition
 * imported by both sides. Every message carries `v: 1`.
 * stateVersion starts at 1 on the first snapshot and increments by
 * exactly 1 per patch; a resync snapshot carries the current version.
 */
import type { Band, ZoneRect } from "./layout.ts";

export const WIRE_VERSION = 1;

export type ParseState = "ok" | "error" | "unparsed";
export type WatcherState = "watching" | "rescanning";

export type Building = {
  id: string;
  path: string;
  zoneId: string;
  /** Slot origin in world units; footprint derives from band. */
  x: number;
  y: number;
  band: Band;
  lines: number;
  bytes: number;
  /** File mtime, ms since epoch: drives landing camera + last-change readout. */
  mtimeMs: number;
  binary: boolean;
  parse: ParseState;
  parseError?: string;
  /** Imports that looked in-repo but matched nothing (T3b belts). */
  unresolvedCount: number;
};

/** One static-import belt between stable building ids (T3b, issue #3). */
export type BeltEdge = {
  fromId: string;
  toId: string;
};

export type SnapshotMessage = {
  v: typeof WIRE_VERSION;
  type: "snapshot";
  stateVersion: number;
  repo: string;
  zones: ZoneRect[];
  buildings: Building[];
  belts: BeltEdge[];
  total: number;
  watcher: WatcherState;
};

export type PatchMessage = {
  v: typeof WIRE_VERSION;
  type: "patch";
  stateVersion: number;
  upsert: Building[];
  remove: string[]; // building ids
  rename: { id: string; from: string; to: string }[];
  belts?: BeltEdge[]; // absent when unchanged since the last send
  zones: ZoneRect[];
  total: number;
  watcher: WatcherState;
};

export type ErrorCode =
  | "bad-auth"
  | "bad-path"
  | "masked-file"
  | "binary-file"
  | "not-found"
  | "bad-message";

export type ServerMessage =
  | { v: typeof WIRE_VERSION; type: "auth-ok"; stateVersion: number }
  | SnapshotMessage
  | PatchMessage
  | { v: typeof WIRE_VERSION; type: "file-content"; path: string; content: string; truncated: boolean; masked: boolean }
  | { v: typeof WIRE_VERSION; type: "notice"; text: string }
  | { v: typeof WIRE_VERSION; type: "error"; code: ErrorCode; message: string };

export type ClientMessage =
  | { v: typeof WIRE_VERSION; type: "auth"; token: string }
  | { v: typeof WIRE_VERSION; type: "resync" }
  | { v: typeof WIRE_VERSION; type: "open-file"; path: string }
  | { v: typeof WIRE_VERSION; type: "relayout" };

/** Client-side floor state; pure so sequencing is unit-testable. */
export type ClientFloorState = {
  version: number;
  repo: string;
  buildings: Map<string, Building>; // by path
  belts: BeltEdge[];
  zones: ZoneRect[];
  total: number;
  watcher: WatcherState;
};

export function createClientState(): ClientFloorState {
  return { version: 0, repo: "", buildings: new Map(), belts: [], zones: [], total: 0, watcher: "rescanning" };
}

export function applySnapshot(state: ClientFloorState, snap: SnapshotMessage): ClientFloorState {
  state.version = snap.stateVersion;
  state.repo = snap.repo;
  state.buildings = new Map(snap.buildings.map((b) => [b.path, b]));
  state.belts = snap.belts;
  state.zones = snap.zones;
  state.total = snap.total;
  state.watcher = snap.watcher;
  return state;
}

/**
 * Apply a patch in gate-note order: remove, rename, upsert, zones,
 * then version/total. Returns "gap" (caller must resync) when the
 * patch does not continue the current version.
 */
export function applyPatch(state: ClientFloorState, patch: PatchMessage): "applied" | "gap" {
  if (patch.stateVersion !== state.version + 1) return "gap";
  const byId = new Map<string, Building>();
  for (const b of state.buildings.values()) byId.set(b.id, b);
  for (const id of patch.remove) {
    const b = byId.get(id);
    if (b) state.buildings.delete(b.path);
  }
  for (const r of patch.rename) {
    const b = state.buildings.get(r.from);
    if (b && b.id === r.id) {
      state.buildings.delete(r.from);
      state.buildings.set(r.to, { ...b, path: r.to });
    }
  }
  for (const b of patch.upsert) state.buildings.set(b.path, b);
  if (patch.belts !== undefined) state.belts = patch.belts;
  state.zones = patch.zones;
  state.total = patch.total;
  state.watcher = patch.watcher;
  state.version = patch.stateVersion;
  return "applied";
}

/**
 * Congested importer ids: the top decile by in-degree, with an
 * absolute floor so sparse graphs (every degree 1) flag nothing.
 * The hazard outline is a rare signal, not wallpaper.
 */
export function computeCongested(inDegree: Map<string, number>): Set<string> {
  const congested = new Set<string>();
  const degs = [...inDegree.values()].filter((d) => d > 0).sort((a, b) => b - a);
  if (degs.length === 0) return congested;
  const threshold = Math.max(degs[Math.max(0, Math.ceil(degs.length / 10) - 1)]!, 3);
  for (const [id, d] of inDegree) if (d >= threshold) congested.add(id);
  return congested;
}

/**
 * True when an upsert changed only the unresolved count (a belt
 * refresh on an untouched file). The client skips the change pulse,
 * the last-change readout, and the preview re-request for these:
 * the file did not change, only its neighborhood did.
 */
export function isCountsOnlyChange(prev: Building | undefined, next: Building): boolean {
  if (!prev) return false;
  const strip = (b: Building): string => {
    const { unresolvedCount: _dropped, ...rest } = b;
    void _dropped;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(prev) === strip(next);
}
