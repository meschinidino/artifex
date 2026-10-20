/**
 * Server<->floor-ui wire protocol v1 (T3a, issue #2). One definition
 * imported by both sides. Every message carries `v: 1`.
 * stateVersion starts at 1 on the first snapshot and increments by
 * exactly 1 per patch; a resync snapshot carries the current version.
 */
import type { BuildingConnections } from "../connections/graph.ts";
import type { Band, ZoneRect } from "./layout.ts";

export type { BuildingConnections };

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
  /** Connection summary (endpoints/tables/calls/topics); absent when none found. */
  conn?: BuildingConnections;
};

/**
 * One planned ghost (ghost layer). Slot origin mirrors Building;
 * the footprint is a fixed band-1 square — a ghost has no line count
 * to size by yet, and ghost-to-solid is the moment size becomes real.
 */
export type GhostBuilding = {
  path: string;
  zoneId: string;
  x: number;
  y: number;
  state: "planned" | "abandoned";
  /** The plan step text that named this path (evidence, inspector). */
  step?: string;
};

/** One agent why-note on a building (floor.annotate, T5). */
export type AgentNote = {
  path: string;
  note: string;
  /** ms epoch. */
  ts: number;
  agentId?: string;
};

export type AgentRunState = "idle" | "working" | "done" | "error";

export type RunState = "running" | "done" | "error" | "stopped";

/**
 * Token usage as reported by the agent for one run. Absent `usage`
 * (or an absent direction within it) means the agent did not
 * report it — never zero, never estimated.
 */
export type RunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * One dispatch run (work order): prompt in, terminal state out. A
 * follow-up dispatch is a new run on the same agent conversation
 * (sessionId). The ledger is per-boot: restarts forget it.
 */
export type RunRecord = {
  /** The dispatch's plan id. */
  id: string;
  sessionId: string;
  /** The prompt as logged: secret-masked, visibly truncated. Never raw. */
  prompt: string;
  /** ms epoch. */
  startedAt: number;
  /** ms epoch; absent while running. */
  endedAt?: number;
  state: RunState;
  /** Exit/error detail for terminal states (masked, capped). */
  detail?: string;
  /**
   * Agent's text answer, concatenated from run.output.delta in
   * arrival order (masked, visibly capped). Absent when the run
   * emitted no text (or none yet).
   */
  answer?: string;
  /**
   * Token usage for this run. Absent = the agent did not report,
   * never zero. Plain counters: nothing to mask, no truncation.
   */
  usage?: RunUsage;
};

/** Worker state for the top strip (D3: what is the worker doing now). */
export type AgentStatus = {
  agentId: string;
  state: AgentRunState;
  sessionId?: string;
  /** Current plan step text while working. */
  step?: string;
  /** Exit/error detail for done/error states. */
  detail?: string;
};

/** One static-import belt between stable building ids (T3b, issue #3). */
export type BeltEdge = {
  fromId: string;
  toId: string;
  /** Contract belts only: a matched HTTP call or a shared Kafka topic. Absent = import. */
  kind?: "http" | "topic";
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
  ghosts: GhostBuilding[];
  agent: AgentStatus;
  runs: RunRecord[];
  /** Agent why-notes, oldest first; empty when nobody annotated. */
  notes: AgentNote[];
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
  /** Full ghost set replacement; absent when unchanged since the last send. */
  ghosts?: GhostBuilding[];
  /** Full agent status replacement; absent when unchanged since the last send. */
  agent?: AgentStatus;
  /** Full run ledger replacement; absent when unchanged since the last send. */
  runs?: RunRecord[];
  /** Full notes replacement; absent when unchanged since the last send. */
  notes?: AgentNote[];
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
  | { v: typeof WIRE_VERSION; type: "trace"; path: string; markdown: string }
  | { v: typeof WIRE_VERSION; type: "notice"; text: string }
  | { v: typeof WIRE_VERSION; type: "error"; code: ErrorCode; message: string };

export type ClientMessage =
  | { v: typeof WIRE_VERSION; type: "auth"; token: string }
  | { v: typeof WIRE_VERSION; type: "resync" }
  | { v: typeof WIRE_VERSION; type: "open-file"; path: string }
  | { v: typeof WIRE_VERSION; type: "export-trace"; path: string }
  | { v: typeof WIRE_VERSION; type: "relayout" }
  | { v: typeof WIRE_VERSION; type: "dispatch"; text: string }
  | { v: typeof WIRE_VERSION; type: "stop-agent" };

/** Client-side floor state; pure so sequencing is unit-testable. */
export type ClientFloorState = {
  version: number;
  repo: string;
  buildings: Map<string, Building>; // by path
  belts: BeltEdge[];
  zones: ZoneRect[];
  total: number;
  watcher: WatcherState;
  ghosts: Map<string, GhostBuilding>; // by path
  agent: AgentStatus;
  runs: RunRecord[];
  notes: AgentNote[];
};

export const IDLE_AGENT: AgentStatus = { agentId: "muse", state: "idle" };

export function createClientState(): ClientFloorState {
  return {
    version: 0,
    repo: "",
    buildings: new Map(),
    belts: [],
    zones: [],
    total: 0,
    watcher: "rescanning",
    ghosts: new Map(),
    agent: IDLE_AGENT,
    runs: [],
    notes: [],
  };
}

export function applySnapshot(state: ClientFloorState, snap: SnapshotMessage): ClientFloorState {
  state.version = snap.stateVersion;
  state.repo = snap.repo;
  state.buildings = new Map(snap.buildings.map((b) => [b.path, b]));
  state.belts = snap.belts;
  state.zones = snap.zones;
  state.total = snap.total;
  state.watcher = snap.watcher;
  state.ghosts = new Map(snap.ghosts.map((g) => [g.path, g]));
  state.agent = snap.agent;
  state.runs = snap.runs;
  state.notes = snap.notes;
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
  if (patch.ghosts !== undefined) state.ghosts = new Map(patch.ghosts.map((g) => [g.path, g]));
  if (patch.agent !== undefined) state.agent = patch.agent;
  if (patch.runs !== undefined) state.runs = patch.runs;
  if (patch.notes !== undefined) state.notes = patch.notes;
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
    // Counts and the connection summary describe the neighborhood,
    // not the file itself: a change confined to them is not an edit.
    const { unresolvedCount: _dropped, conn: _conn, ...rest } = b;
    void _dropped;
    void _conn;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(prev) === strip(next);
}
