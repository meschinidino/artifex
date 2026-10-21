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
  /**
   * Working-tree footprint vs HEAD (change-footprint overlays).
   * Absent = clean or status unavailable — the client tells them
   * apart via `footAvailable`, never via this field.
   */
  foot?: "added" | "modified";
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

/**
 * One removed marker (footprint overlays): a live-observed
 * deletion's last-known slot. Slot origin mirrors Building;
 * machine-sized by band with the standard slot inset.
 */
export type RemovedMark = {
  path: string;
  zoneId: string;
  x: number;
  y: number;
  band: Band;
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
  /**
   * Server evidence, display-ready, one item per relationship
   * (BCR4): `line 12: <source text>` per import line,
   * `GET /path — line 42: <text>` per HTTP call,
   * `topic via handler — line 17: <text>` per produce. Source
   * text is trimmed, secret-masked, and capped at 120 chars;
   * unreadable lines fall back to the bare citation. Absent =
   * endpoints only (older evidence or none recorded).
   */
  via?: string[];
};

/** Resolved belt-click card: endpoint paths plus the pair's edges. */
export type EdgePairCard = {
  fromPath: string;
  toPath: string;
  /** Snapshot-order edges for the pair; empty + gone when none remain. */
  edges: BeltEdge[];
  gone: boolean;
};

/**
 * Resolve a clicked endpoint pair to its card model (BCR4). Both
 * ids must map to live buildings, else undefined (caller clears
 * the selection); zero edges resolves to a gone card, never
 * undefined, so the inspector can say so instead of going blank.
 */
export function resolveEdgePair(
  belts: readonly BeltEdge[],
  buildings: ReadonlyMap<string, Building> | readonly Building[],
  fromId: string,
  toId: string,
): EdgePairCard | undefined {
  const list = Array.isArray(buildings) ? buildings : [...buildings.values()];
  const fromPath = list.find((b) => b.id === fromId)?.path;
  const toPath = list.find((b) => b.id === toId)?.path;
  if (fromPath === undefined || toPath === undefined) return undefined;
  const edges = belts.filter((e) => e.fromId === fromId && e.toId === toId);
  return { fromPath, toPath, edges, gone: edges.length === 0 };
}

/**
 * Whether an endpoint pair touches a building path (BCR5): the
 * belt-click keeps a selected machine while its own belts are
 * inspected, and only a foreign belt switches the selection.
 */
export function pairIncidentToPath(
  buildings: ReadonlyMap<string, Building> | readonly Building[],
  fromId: string,
  toId: string,
  path: string,
): boolean {
  const list = Array.isArray(buildings) ? buildings : [...buildings.values()];
  const id = list.find((b) => b.path === path)?.id;
  return id !== undefined && (id === fromId || id === toId);
}

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
  /** Live-observed deletions with a last-known slot, path order. */
  removed: RemovedMark[];
  /**
   * Removed-vs-HEAD paths with no live-observed slot (pre-boot
   * deletions and the like): counted, never drawn, path order.
   */
  removedUnplotted: string[];
  /**
   * Labels with fresh git status (`""` on a single-repo floor):
   * the client cannot tell clean from unknown without this.
   */
  footAvailable: string[];
  /**
   * True when the primary repo's `AGENTS.md` already holds the
   * lessons section: the Lessons preview shows the header line
   * only when this is false. Refreshed on snapshot; a successful
   * write-back ack flips the client's copy (the server ensures
   * the section at append time).
   */
  hasLessonsSection: boolean;
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
  /** Full removed-marks replacement; absent when unchanged since the last send. */
  removedMarks?: RemovedMark[];
  /** Full unplotted-removed replacement; absent when unchanged since the last send. */
  removedUnplotted?: string[];
  /** Full status-availability replacement; absent when unchanged since the last send. */
  footAvailable?: string[];
};

export type ErrorCode =
  | "bad-auth"
  | "bad-path"
  | "masked-file"
  | "binary-file"
  | "not-found"
  | "summary-failed"
  | "lines-failed"
  | "bad-message";

/** AI summary target (SUM1): a file path or a belt pair. */
export type SummaryTarget = { kind: "file"; path: string } | { kind: "belt"; fromId: string; toId: string };

export type ServerMessage =
  | { v: typeof WIRE_VERSION; type: "auth-ok"; stateVersion: number }
  | SnapshotMessage
  | PatchMessage
  | { v: typeof WIRE_VERSION; type: "file-content"; path: string; content: string; truncated: boolean; masked: boolean }
  | { v: typeof WIRE_VERSION; type: "diff"; path: string; added: number; removed: number; hunks: string; truncated: boolean; masked: boolean; untracked: boolean }
  | { v: typeof WIRE_VERSION; type: "trace"; path: string; markdown: string }
  | { v: typeof WIRE_VERSION; type: "summary"; target: SummaryTarget; text: string; generatedAt: string; cached: boolean }
  | { v: typeof WIRE_VERSION; type: "lines"; path: string; center: number; start: number; total: number; lines: string[] }
  | { v: typeof WIRE_VERSION; type: "notice"; text: string }
  | { v: typeof WIRE_VERSION; type: "writeback-result"; runId: string; ok: boolean; text: string }
  | { v: typeof WIRE_VERSION; type: "error"; code: ErrorCode; message: string };

export type ClientMessage =
  | { v: typeof WIRE_VERSION; type: "auth"; token: string }
  | { v: typeof WIRE_VERSION; type: "resync" }
  | { v: typeof WIRE_VERSION; type: "open-file"; path: string }
  | { v: typeof WIRE_VERSION; type: "get-diff"; path: string }
  | { v: typeof WIRE_VERSION; type: "get-summary"; target: SummaryTarget }
  | { v: typeof WIRE_VERSION; type: "get-lines"; path: string; center: number; radius?: number }
  | { v: typeof WIRE_VERSION; type: "export-trace"; path: string }
  | { v: typeof WIRE_VERSION; type: "relayout" }
  | { v: typeof WIRE_VERSION; type: "dispatch"; text: string }
  | { v: typeof WIRE_VERSION; type: "stop-agent" }
  // Lessons are human-authored, never generated; the client trims
  // and drops empty lines, and the server re-validates run state
  // and caps before appending (see server/writeback.ts).
  | { v: typeof WIRE_VERSION; type: "writeback"; runId: string; lessons: string[] };

/**
 * Fenced write-back section in the instruction file. A stable
 * contract: future slices reuse this exact header string, and the
 * presence check is a line-exact match (a lesson merely mentioning
 * the header must never read as the section itself).
 */
export const WRITEBACK_SECTION_HEADER = "## Run lessons (artifex write-back)";
/** Max non-empty lesson lines per write-back request (extras refused, never dropped). */
export const MAX_LESSONS_PER_RUN = 5;
/** Max chars per lesson line, masked form (over-long lines cap with a visible …). */
export const MAX_LESSON_CHARS = 280;
/** Instruction files past this size are refused without a full read. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

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
  removed: Map<string, RemovedMark>; // by path
  removedUnplotted: string[];
  footAvailable: string[];
  hasLessonsSection: boolean;
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
    removed: new Map(),
    removedUnplotted: [],
    footAvailable: [],
    hasLessonsSection: false,
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
  state.removed = new Map(snap.removed.map((m) => [m.path, m]));
  state.removedUnplotted = snap.removedUnplotted;
  state.footAvailable = snap.footAvailable;
  state.hasLessonsSection = snap.hasLessonsSection;
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
  if (patch.removedMarks !== undefined) state.removed = new Map(patch.removedMarks.map((m) => [m.path, m]));
  if (patch.removedUnplotted !== undefined) state.removedUnplotted = patch.removedUnplotted;
  if (patch.footAvailable !== undefined) state.footAvailable = patch.footAvailable;
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
 * True when an upsert changed only the unresolved count, the
 * connection summary, or the footprint (belt refreshes and status
 * re-reads on an untouched file). The client skips the change
 * pulse, the last-change readout, and the preview re-request for
 * these: the file did not change, only its neighborhood or its
 * HEAD-relative status did.
 */
export function isCountsOnlyChange(prev: Building | undefined, next: Building): boolean {
  if (!prev) return false;
  const strip = (b: Building): string => {
    // Counts, the connection summary, and the footprint describe
    // the neighborhood and the HEAD baseline, not the file itself:
    // a change confined to them is not an edit.
    const { unresolvedCount: _dropped, conn: _conn, foot: _foot, ...rest } = b;
    void _dropped;
    void _conn;
    void _foot;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(prev) === strip(next);
}
