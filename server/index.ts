/**
 * Artifex floor server (T3a, issue #2): one Bun process on 127.0.0.1
 * owns floor state, serves the floor UI, and streams snapshot+patch
 * over a token-authenticated WebSocket. The token is injected into
 * the served HTML only — never in URLs or logs.
 */
import { closeSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { EVENTS_VERSION, MAX_TEXT_CHARS, validateFloorEvent, type FloorEvent } from "../events/index.ts";
import {
  LAYOUT_VERSION,
  PITCH,
  ZONE_GAP,
  ZONE_HEADER,
  assignBuilding,
  bandForFile,
  layoutFloor,
  removeBuilding,
  renameBuilding,
  zoneOf,
  zoneRects,
  type FloorLayout,
} from "../floor-ui/layout.ts";
import {
  WIRE_VERSION,
  type AgentStatus,
  type BeltEdge,
  type Building,
  type ClientMessage,
  type GhostBuilding,
  type ServerMessage,
  type WatcherState,
} from "../floor-ui/wire.ts";
import { createParserClient, languageForPath, MAX_PARSE_BYTES, type ParseResult, type ParserClient } from "../parser/index.ts";
import { parseStateForResult, type ImportRef } from "../parser/protocol.ts";
import { buildJvmIndex, buildResolverContext, resolveFileImports, type FileBelts, type ResolverContext } from "../resolver/resolver.ts";
import { extractConnections } from "../connections/extract.ts";
import { buildConnectionGraph, detectServiceName, type BuildingConnections, type RepoInput } from "../connections/graph.ts";
import type { FileConnections } from "../connections/types.ts";
import { diffListing, snapshotMeta, watchRepo, type FileMeta as WatchFileMeta, type WatchChange, type WatcherHandle } from "../watcher/index.ts";
import { decodeUtf8Prefix, isBinaryBuffer, isEnvFile, maskContent } from "../watcher/mask.ts";
import { isExcluded, listFiles } from "../watcher/scan.ts";
import { resolveInsideRepo } from "./paths.ts";
import { appendEventLog, compactEventLog, EVENT_LOG_COMPACT_AT, EVENT_LOG_MAX, loadEventLog } from "./store.ts";
import { createIntentGate, PLAN_IDLE_TIMEOUT_MS, type IntentGate } from "./intent.ts";
import {
  MUSE_AGENT_ID,
  currentStep,
  extractPathsFromText,
  plannedEventFromTodo,
  startMuseRun,
  type AgentRun,
  type MuseStreamEvent,
  type SpawnFn,
} from "../agents/muse-adapter.ts";

const STATE_DIR = ".artifex";
const STATE_FILE = "floor-state.json";
const PATCH_BATCH_MS = 50;
const CONTENT_CAP = 256 * 1024;
/** Ghost expiry sweep cadence (D7/D20 abandonment). */
const GHOST_SWEEP_MS = 30 * 1000;
/** Max rate of observed activity heartbeats ingested per run. */
const AGENT_HEARTBEAT_MS = 30 * 1000;

type SocketData = { authed: boolean };

export type FloorServer = {
  port: number;
  token: string;
  url: string;
  eventLog: readonly FloorEvent[];
  buildingCount(): number;
  /** Live ghost set (planned + abandoned), for tests and debugging. */
  ghosts(): readonly GhostBuilding[];
  /** Current worker state, for tests and debugging. */
  agentStatus(): AgentStatus;
  stop(): void;
};

export async function countNewlines(absolute: string): Promise<number> {
  let n = 0;
  let last = -1;
  for await (const chunk of createReadStream(absolute)) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf.length > 0) last = buf[buf.length - 1]!;
  }
  return last === 10 || last === -1 ? n : n + 1;
}

export function countBufferLines(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

const MAX_STATE_BYTES = 8 * 1024 * 1024;

/**
 * Deep-validate persisted state (it is untrusted input: an agent can
 * write it) and re-home records into null-prototype dictionaries.
 * Anything anomalous throws, and the caller resets to a fresh layout.
 */
export function validatePersistedLayout(parsed: unknown): FloorLayout {
  const isRec = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (!isRec(parsed) || parsed.v !== LAYOUT_VERSION) throw new Error("bad version");
  if (!isRec(parsed.zones) || !isRec(parsed.buildings)) throw new Error("bad records");
  if (!num(parsed.nextZoneX) || !Number.isSafeInteger(parsed.nextZoneX) || parsed.nextZoneX < 0
    || !num(parsed.nextId) || !Number.isSafeInteger(parsed.nextId) || parsed.nextId < 1 || parsed.nextId > 1_000_000_000) throw new Error("bad counters");
  const zones: Record<string, { x: number; cols: number; nextSlot: number }> = Object.create(null);
  for (const [id, z] of Object.entries(parsed.zones)) {
    if (!isRec(z) || !num(z.x) || !Number.isSafeInteger(z.x) || z.x < 0
      || !num(z.cols) || !Number.isSafeInteger(z.cols) || z.cols < 1 || z.cols > 16
      || !num(z.nextSlot) || !Number.isSafeInteger(z.nextSlot) || z.nextSlot < 0 || z.nextSlot > 1_000_000) {
      throw new Error(`bad zone ${id}`);
    }
    zones[id] = { x: z.x, cols: z.cols, nextSlot: z.nextSlot };
  }
  // Zone columns are appended left-to-right and never overlap; the
  // append cursor must sit past every existing column. Coordinates
  // are bounded by what the layout engine can actually mint, so a
  // crafted state cannot make the client draw billions of seams.
  const maxCoord = Math.max(1, Object.keys(zones).length) * (16 * PITCH + ZONE_GAP);
  if (parsed.nextZoneX > maxCoord || Object.values(zones).some((z) => z.x > maxCoord)) {
    throw new Error("bad zone coordinates");
  }
  const orderedZones = Object.values(zones).sort((a, b) => a.x - b.x);
  for (let i = 1; i < orderedZones.length; i++) {
    const prev = orderedZones[i - 1]!;
    if (orderedZones[i]!.x < prev.x + prev.cols * PITCH + ZONE_GAP) throw new Error("overlapping zones");
  }
  if (orderedZones.length > 0) {
    const last = orderedZones[orderedZones.length - 1]!;
    if (parsed.nextZoneX < last.x + last.cols * PITCH + ZONE_GAP) throw new Error("bad nextZoneX");
  }
  const buildings: Record<string, { id: string; zoneId: string; slot: number; x: number; y: number }> = Object.create(null);
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const [path, b] of Object.entries(parsed.buildings)) {
    if (!isRec(b) || typeof b.id !== "string" || !/^b\d+$/.test(b.id)
      || typeof b.zoneId !== "string" || !num(b.slot) || !Number.isSafeInteger(b.slot) || b.slot < 0
      || !num(b.x) || !num(b.y) || ids.has(b.id)) {
      throw new Error(`bad building ${path}`);
    }
    // A counter at or below an existing id would mint duplicates.
    if (Number(b.id.slice(1)) >= parsed.nextId) throw new Error(`bad building ${path}`);
    const zone = zones[b.zoneId];
    if (!zone || b.slot >= zone.nextSlot) throw new Error(`bad building ${path}`);
    const slotKey = `${b.zoneId}\0${b.slot}`;
    if (slots.has(slotKey)) throw new Error(`bad building ${path}`);
    ids.add(b.id);
    slots.add(slotKey);
    // Coordinates are derived from zone+slot; never trust stored x/y.
    buildings[path] = {
      id: b.id,
      zoneId: b.zoneId,
      slot: b.slot,
      x: zone.x + (b.slot % zone.cols) * PITCH,
      y: ZONE_HEADER + Math.floor(b.slot / zone.cols) * PITCH,
    };
  }
  return { v: LAYOUT_VERSION, zones, buildings, nextZoneX: parsed.nextZoneX, nextId: parsed.nextId };
}

export function loadPersistedLayout(repo: string): { layout?: FloorLayout; reset: boolean } {
  const dir = join(repo, STATE_DIR);
  const file = join(dir, STATE_FILE);
  let fileStat;
  try {
    fileStat = lstatSync(file);
  } catch {
    return { reset: false };
  }
  // The .bak rename below is only safe once both paths are proven to
  // be real in-repo entries: through a planted symlink it would
  // rename a file outside the repo.
  let safeToRename = false;
  try {
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("state dir is not a real directory");
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("state file is not a regular file");
    safeToRename = true;
    if (fileStat.size > MAX_STATE_BYTES) throw new Error("state too large");
    // Bounded read of the just-checked regular file: never an
    // unbounded readFileSync on an untrusted path (a special file
    // reporting size 0 would otherwise read or block forever).
    const fd = openSync(file, "r");
    let text: string;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_STATE_BYTES) throw new Error("state file changed during load");
      const buf = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < opened.size) {
        const read = readSync(fd, buf, offset, opened.size - offset, offset);
        if (read === 0) throw new Error("state file truncated during load");
        offset += read;
      }
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    return { layout: validatePersistedLayout(JSON.parse(text)), reset: false };
  } catch {
    if (safeToRename) {
      try { renameSync(file, `${file}.bak`); } catch { /* keep going unstuck */ }
    }
    return { reset: true };
  }
}

function isConfigFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === "package.json" || base === "tsconfig.json" || base === "go.mod";
}

function isInitPy(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1) === "__init__.py";
}

function isJvmFile(path: string): boolean {
  return /\.(java|kt|kts)$/.test(path);
}

function isGoFile(path: string): boolean {
  return /\.go$/.test(path);
}

/**
 * Whether a change alters resolver context: config content always
 * counts, while __init__.py counts on existence flips only (roots
 * do not depend on its content). JVM files likewise count on
 * existence flips (the FQN index gains/loses declaring files);
 * content edits that change a file's package or declared types are
 * detected against the stored parse info in the change pipeline.
 */
export function affectsContext(change: WatchChange): boolean {
  if (change.kind === "renamed") {
    return (
      isConfigFile(change.fromPath) ||
      isConfigFile(change.path) ||
      isInitPy(change.fromPath) ||
      isInitPy(change.path) ||
      isJvmFile(change.fromPath) ||
      isJvmFile(change.path) ||
      isGoFile(change.fromPath) ||
      isGoFile(change.path)
    );
  }
  if (isConfigFile(change.path)) return true;
  return (isInitPy(change.path) || isJvmFile(change.path) || isGoFile(change.path)) && change.kind !== "modified";
}

/**
 * Persist gate: the read side refuses state over MAX_STATE_BYTES, so
 * writing it anyway would reset the layout on every boot and churn
 * .bak forever. Byte length, not char length: a multibyte state can
 * fit the char count while busting the byte budget.
 */
export function shouldPersistLayout(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_STATE_BYTES;
}

export type ReconcilePlan = {
  groups: [WatchChange[], WatchChange[], WatchChange[], WatchChange[]];
  handled: Set<string>;
};

/**
 * Boot-window reconcile planner: files changed between the boot
 * reads and the watcher's baseline snapshot are invisible to a
 * plain known-vs-current diff, so also compare against built
 * buildings. Groups run in order (later groups observe earlier
 * groups' buildings); the handled set dedupes across groups.
 */
export function planReconcile(
  known: Map<string, WatchFileMeta>,
  current: Map<string, WatchFileMeta>,
  buildings: Map<string, { mtimeMs: number; bytes: number }>,
): ReconcilePlan {
  const handled = new Set<string>();
  const mark = (change: WatchChange) => {
    handled.add(change.path);
    if (change.kind === "renamed") handled.add(change.fromPath);
  };
  const groups: ReconcilePlan["groups"] = [[], [], [], []];
  groups[0] = diffListing(known, current);
  for (const change of groups[0]) mark(change);
  groups[1] = [...buildings.keys()]
    .filter((p) => !current.has(p) && !handled.has(p))
    .map((path) => ({ kind: "deleted", path }) as WatchChange);
  for (const change of groups[1]) mark(change);
  groups[2] = [...current.keys()]
    .filter((p) => !buildings.has(p) && !handled.has(p))
    .map((path) => ({ kind: "created", path }) as WatchChange);
  for (const change of groups[2]) mark(change);
  groups[3] = [...current]
    .filter(([path, meta]) => {
      const b = buildings.get(path);
      return !!b && !handled.has(path) && (b.mtimeMs !== meta.mtimeMs || b.bytes !== meta.size);
    })
    .map(([path]) => ({ kind: "modified", path }) as WatchChange);
  for (const change of groups[3]) mark(change);
  return { groups, handled };
}

/**
 * Sync the watcher baseline for reconciled paths. Unbuilt paths stay
 * out of the baseline so a later readable state re-detects as
 * created; handled-but-vanished entries clear.
 */
export function syncReconcileBaseline(
  known: Map<string, WatchFileMeta>,
  current: Map<string, WatchFileMeta>,
  buildings: Map<string, unknown>,
  handled: Set<string>,
): void {
  for (const [path, meta] of current) {
    if (buildings.has(path)) known.set(path, meta);
    else known.delete(path);
  }
  for (const path of [...known.keys()]) {
    if (handled.has(path) && !current.has(path)) known.delete(path);
  }
}

export async function createFloorServer(opts: {
  repo: string;
  /** All repos for a federated floor (defaults to [repo]). Each becomes a district zone. */
  repos?: string[];
  port?: number;
  /**
   * Agent dispatch (ghost layer). `false` disables dispatch (watch
   * only). Omitted means enabled with the real `muse` on PATH.
   * spawnFn/timeoutMs/idleTimeoutMs/sessionId are test seams.
   */
  agent?: false | {
    command?: string;
    spawnFn?: SpawnFn;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    sessionId?: string;
    /** Test seam: idle-sweep cadence (default GHOST_SWEEP_MS). */
    sweepMs?: number;
  };
}): Promise<FloorServer> {
  const repoPaths = (opts.repos ?? [opts.repo]).map((p) => resolve(p));
  // Fail fast on a typo'd --repo: without this, the empty listing
  // would boot an empty floor and persistLayout would create the
  // missing directory tree just to write state into it.
  for (const p of repoPaths) {
    try {
      if (!statSync(p).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`repo is not a directory: ${p}`);
    }
  }
  // Federation: several repos share one floor when they share a
  // parent directory — the parent becomes the floor root and each
  // repo is a district (its basename is the zone + path prefix).
  const multi = repoPaths.length > 1;
  const labels: string[] = multi ? repoPaths.map((p) => basename(p)) : [""];
  if (multi) {
    const parent = dirname(repoPaths[0]!);
    if (repoPaths.some((p) => dirname(p) !== parent)) {
      throw new Error("federated repos must share a parent directory");
    }
    if (new Set(labels).size !== labels.length) throw new Error("federated repo directory names must be unique");
  }
  const repo = multi ? dirname(repoPaths[0]!) : repoPaths[0]!;
  const splitPrefixed = (path: string): { label: string; rel: string } => {
    if (!multi) return { label: "", rel: path };
    const slash = path.indexOf("/");
    return slash === -1 ? { label: path, rel: "" } : { label: path.slice(0, slash), rel: path.slice(slash + 1) };
  };
  const prefixedPath = (label: string, rel: string): string => (label ? `${label}/${rel}` : rel);
  const listAllFiles = (): string[] =>
    multi
      ? repoPaths.flatMap((r) => listFiles(r).map((p) => `${basename(r)}/${p}`))
      : listFiles(repo);
  const token = crypto.randomUUID();
  const parser: ParserClient = createParserClient();
  // Durable history (T4): the log continues across restarts, so the
  // ghost layer reads intent it saw before a relaunch.
  const persistedLog = loadEventLog(repo);
  const eventLog: FloorEvent[] = [...persistedLog.events];
  let eventLogLines = persistedLog.lines;

  let watcherState: WatcherState = "rescanning";
  let version = 1;
  let bootSkipped = 0;
  let layout: FloorLayout;
  const buildings = new Map<string, Building>();

  // Ghost layer (eng review D7/D8/D20): paths an agent stated it
  // will create or modify on a measured intent channel, tracked
  // until they solidify (bound write), are superseded (unbound
  // write), or abandon (idle expiry / run end). The intent gate is
  // the only thing allowed to call a write "intended" (intent.ts);
  // this store owns path-vs-plan attribution.
  type GhostRec = {
    planId: string;
    sessionId: string;
    step?: string;
    state: "planned" | "abandoned";
  };
  const ghosts = new Map<string, GhostRec>();
  const planActivity = new Map<string, number>();
  const agentOpts = opts.agent === false ? undefined : (opts.agent ?? {});
  const agentIdleTimeoutMs = agentOpts?.idleTimeoutMs ?? PLAN_IDLE_TIMEOUT_MS;
  const gate: IntentGate = createIntentGate({ idleTimeoutMs: agentIdleTimeoutMs });
  // One muse session per floor lifetime: follow-up dispatches resume
  // the same conversation (spike-verified via --session-id).
  const agentSessionId = agentOpts?.sessionId ?? crypto.randomUUID();
  let agentStatus: AgentStatus = {
    agentId: MUSE_AGENT_ID,
    state: "idle",
    ...(agentOpts ? { sessionId: agentSessionId } : { detail: "no agent configured" }),
  };
  let activeRun: AgentRun | undefined;
  let activePlanId: string | undefined;
  let runSessionId = agentSessionId;
  let stopRequested = false;
  let lastHeartbeatTs = 0;
  let stderrTail = "";
  let ghostsDirty = false;
  let agentDirty = false;
  // Belt state (T3b, issue #3): raw parser imports per path, their
  // resolution, and the resolver context over the known file set.
  const importsByPath = new Map<string, ImportRef[]>();
  // JVM parse facts per path: feeds the FQN index and the resolver's
  // same-package / wildcard hints. Kept on failed parses, like imports.
  type ParseInfo = { packageName?: string; declaredTypes?: string[]; typeRefs?: string[] };
  const parseInfoByPath = new Map<string, ParseInfo>();
  let jvmIndexStale = false;
  const jvmSignature = (info: ParseInfo | undefined): string =>
    info ? `${info.packageName ?? ""}\0${(info.declaredTypes ?? []).join("\0")}` : "";
  function noteParseResult(path: string, result: ParseResult | undefined) {
    if (result?.ok) {
      importsByPath.set(path, result.imports);
      const next: ParseInfo = { packageName: result.packageName, declaredTypes: result.declaredTypes, typeRefs: result.typeRefs };
      if (jvmSignature(parseInfoByPath.get(path)) !== jvmSignature(next)) jvmIndexStale = true;
      parseInfoByPath.set(path, next);
    } else if (result === undefined) {
      importsByPath.delete(path);
      if (parseInfoByPath.delete(path)) jvmIndexStale = true;
    }
  }
  // Connection facts per path + the summarized graph over them.
  // Rebuilt at boot and at batch end whenever a supported file's
  // facts changed; buildings carry the summary on the wire.
  const connectionsByPath = new Map<string, FileConnections>();
  const connByPath = new Map<string, BuildingConnections>();
  let connectionsDirty = false;
  function noteConnections(path: string, text: string | undefined) {
    if (text === undefined) return;
    // A throwing extractor must fail that file's connections
    // closed (dropped + logged), never abort the boot chunk.
    let fc: FileConnections | undefined;
    try {
      fc = extractConnections(path, text);
    } catch (err) {
      console.error(`warn: connection extraction failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
      if (connectionsByPath.delete(path)) connectionsDirty = true;
      return;
    }
    if (fc) {
      connectionsByPath.set(path, fc);
      connectionsDirty = true;
    } else if (connectionsByPath.delete(path)) {
      connectionsDirty = true;
    }
  }
  function dropConnections(path: string) {
    if (connectionsByPath.delete(path)) connectionsDirty = true;
    connByPath.delete(path);
  }
  function isTrivialConn(c: BuildingConnections): boolean {
    // Unresolved notes alone still matter: a file whose only
    // connection fact is "dynamic, unproven" must show exactly that.
    return c.endpoints.length === 0 && c.calls.length === 0 && c.tables.length === 0 && c.topics.length === 0 && c.kinds.length === 0 && c.unresolvedNotes === 0;
  }
  /** Rebuild summaries; upserts buildings whose summary changed (boot writes buildings only). */
  function recomputeConnections(boot = false) {
    const inputs: RepoInput[] = labels.map((label) => {
      const typeIndex = new Map<string, string[]>();
      const addType = (name: string, path: string) => {
        const list = typeIndex.get(name) ?? [];
        if (!list.includes(path)) list.push(path);
        typeIndex.set(name, list);
      };
      const files = new Map<string, FileConnections>();
      const relFiles: string[] = [];
      for (const f of knownFiles) {
        const s = splitPrefixed(f);
        if (s.label === label) relFiles.push(s.rel);
      }
      for (const [path, info] of parseInfoByPath) {
        const s = splitPrefixed(path);
        if (s.label === label) for (const t of info.declaredTypes ?? []) addType(t, s.rel);
      }
      for (const [path, fc] of connectionsByPath) {
        const s = splitPrefixed(path);
        if (s.label !== label) continue;
        files.set(s.rel, fc);
        if (fc.className) addType(fc.className, s.rel);
      }
      const importTargets = new Map<string, Set<string>>();
      for (const [path, belts] of beltsByPath) {
        const s = splitPrefixed(path);
        if (s.label === label) importTargets.set(s.rel, new Set(belts.targets.map((t) => splitPrefixed(t).rel)));
      }
      const importSpecifiers = new Map<string, string[]>();
      for (const [path, refs] of importsByPath) {
        const s = splitPrefixed(path);
        if (s.label !== label) continue;
        importSpecifiers.set(s.rel, refs.flatMap((r) =>
          r.lang === "jvm" ? [r.fqn] : r.lang === "py" ? r.names.map((n) => `${r.module}.${n}`) : [r.specifier],
        ));
      }
      return {
        label,
        serviceName: detectServiceName(relFiles, (p) => readConfigText(prefixedPath(label, p))),
        files,
        typeIndex,
        importTargets,
        importSpecifiers,
      };
    });
    const graph = buildConnectionGraph(inputs);
    connByPath.clear();
    for (const [key, summary] of graph.byFile) {
      const sepAt = key.indexOf("\0");
      const label = key.slice(0, sepAt);
      const rel = key.slice(sepAt + 1);
      if (!isTrivialConn(summary)) connByPath.set(prefixedPath(label, rel), summary);
    }
    for (const [path, b] of buildings) {
      const next = connByPath.get(path);
      if (JSON.stringify(b.conn) !== JSON.stringify(next)) {
        const fresh: Building = { ...b };
        if (next) fresh.conn = next;
        else delete fresh.conn;
        buildings.set(path, fresh);
        if (!boot) {
          pending.upsert.set(path, fresh);
          // Contract belts derive from conn summaries: a route,
          // Feign path, or topic edit changes edges even when no
          // import moved, so belt re-emission must be forced.
          beltsDirty = true;
        }
      }
    }
    connectionsDirty = false;
  }
  const beltsByPath = new Map<string, FileBelts>();
  const knownFiles = new Set<string>();
  const EMPTY_RESOLVER_CTX: ResolverContext = {
    files: new Set(),
    packages: new Map(),
    tsconfigs: new Map(),
    pyRoots: [""],
    jvmTypes: new Map(),
    jvmPackages: new Set(),
    goFilesByDir: new Map(),
    isExcluded,
  };
  // One resolver context per repo: JVM FQN indexes and Go modules
  // must never leak across districts on a federated floor.
  const resolverCtxByLabel = new Map<string, ResolverContext>();
  // Persistent per-label file sets: contexts hold these by
  // reference, so membership changes (create/delete/rename) are
  // visible to resolution without a context rebuild — the same
  // live-set contract the single-repo knownFiles set provided.
  const relFilesByLabel = new Map<string, Set<string>>(labels.map((l) => [l, new Set<string>()]));
  function syncRelFiles(label: string) {
    const set = relFilesByLabel.get(label)!;
    set.clear();
    for (const f of knownFiles) {
      const s = splitPrefixed(f);
      if (s.label === label) set.add(s.rel);
    }
  }
  /** Incremental membership: knownFiles and the label's rel set move together. */
  function trackKnown(path: string, present: boolean) {
    if (present) knownFiles.add(path);
    else knownFiles.delete(path);
    const { label, rel } = splitPrefixed(path);
    const set = relFilesByLabel.get(label);
    if (!set) return;
    if (present) set.add(rel);
    else set.delete(rel);
  }
  const ctxFor = (label: string): ResolverContext => resolverCtxByLabel.get(label) ?? EMPTY_RESOLVER_CTX;
  function resolveForPath(path: string): FileBelts {
    const { label, rel } = splitPrefixed(path);
    const belts = resolveFileImports(rel, importsByPath.get(path) ?? [], ctxFor(label), parseInfoByPath.get(path));
    return { targets: belts.targets.map((t) => prefixedPath(label, t)), unresolved: belts.unresolved };
  }
  let beltsDirty = false;
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const MAX_SOCKETS = 64;
  const AUTH_TIMEOUT_MS = 5_000;
  const authTimers = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>();
  let closed = false;

  const stateFile = join(repo, STATE_DIR, STATE_FILE);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persistLayout() {
    let tmp: string | undefined;
    try {
      const dir = join(repo, STATE_DIR);
      // A planted .artifex symlink must not redirect state writes
      // outside the repo (the repo being viewed is untrusted input).
      try {
        if (lstatSync(dir).isSymbolicLink()) {
          console.error("warn: .artifex is a symlink; refusing to write floor state");
          return;
        }
      } catch { /* missing: created below */ }
      mkdirSync(dir, { recursive: true });
      const text = JSON.stringify(layout);
      if (!shouldPersistLayout(text)) {
        console.error(`warn: floor state exceeds ${MAX_STATE_BYTES} bytes; skipping persist`);
        return;
      }
      tmp = `${stateFile}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
      writeFileSync(tmp, text, { flag: "wx" });
      renameSync(tmp, stateFile);
      tmp = undefined;
    } catch (err) {
      if (tmp) try { unlinkSync(tmp); } catch { /* already gone */ }
      console.error(`warn: could not persist floor state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  function saveLayout() {
    if (closed || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persistLayout();
    }, 250);
  }

  function emitEvent(event: Record<string, unknown>) {
    try {
      const validated = validateFloorEvent({ v: EVENTS_VERSION, id: crypto.randomUUID(), ts: Date.now(), agentId: "watcher", ...event });
      eventLog.push(validated);
      if (eventLog.length > EVENT_LOG_MAX) eventLog.splice(0, eventLog.length - EVENT_LOG_MAX);
      if (appendEventLog(repo, validated)) {
        eventLogLines++;
        if (eventLogLines > EVENT_LOG_COMPACT_AT) eventLogLines = compactEventLog(repo);
      }
    } catch (err) {
      console.error(`warn: watcher event rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- ghost layer intake ---------------------------------------------
  // Intent-channel events reach the floor through here, never through
  // emitEvent: the durable-append result feeds the binding gate (an
  // unpersisted plan records but never binds — intent.ts header).
  function ingestAgentEvent(event: FloorEvent) {
    eventLog.push(event);
    if (eventLog.length > EVENT_LOG_MAX) eventLog.splice(0, eventLog.length - EVENT_LOG_MAX);
    const persisted = appendEventLog(repo, event);
    if (persisted) {
      eventLogLines++;
      if (eventLogLines > EVENT_LOG_COMPACT_AT) eventLogLines = compactEventLog(repo);
    }
    return gate.ingest(event, { persisted });
  }

  function currentGhosts(): GhostBuilding[] {
    const out: GhostBuilding[] = [];
    for (const [path, g] of ghosts) {
      const placed = layout.buildings[path];
      if (!placed) continue; // slot pruned: nowhere honest for the ghost to sit
      out.push({
        path,
        zoneId: placed.zoneId,
        x: placed.x,
        y: placed.y,
        state: g.state,
        ...(g.step ? { step: g.step } : {}),
      });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : 1));
    return out;
  }

  function setAgentStatus(status: AgentStatus) {
    agentStatus = status;
    agentDirty = true;
    schedulePatch();
  }

  function upsertGhosts(planId: string, sessionId: string, stepsByPath: Map<string, string>) {
    // A re-plan replaces: planned ghosts of this plan not restated
    // in the latest snapshot drop out (the gate replaces the record
    // the same way).
    for (const [path, g] of ghosts) {
      if (g.planId === planId && g.state === "planned" && !stepsByPath.has(path)) ghosts.delete(path);
    }
    for (const [path, step] of stepsByPath) {
      // Reserve the slot now so ghost-to-solid lands in the same
      // slot: assignBuilding returns the existing placement when
      // the file actually arrives.
      assignBuilding(layout, path);
      ghosts.set(path, { planId, sessionId, step, state: "planned" });
    }
    ghostsDirty = true;
    saveLayout();
    schedulePatch();
  }

  function abandonPlan(planId: string) {
    const entries = [...ghosts.entries()].filter(([, g]) => g.planId === planId && g.state === "planned");
    if (entries.length === 0) return;
    const paths = entries.map(([p]) => p);
    const sessionId = entries[0]![1].sessionId;
    const idleMs = Math.max(0, Date.now() - (planActivity.get(planId) ?? Date.now()));
    try {
      const event = validateFloorEvent({
        v: EVENTS_VERSION,
        id: crypto.randomUUID(),
        ts: Date.now(),
        sessionId,
        agentId: MUSE_AGENT_ID,
        type: "abandoned-plan",
        provenance: "intended",
        planId,
        paths,
        idleMs,
      });
      ingestAgentEvent(event);
    } catch (err) {
      console.error(`warn: abandoned-plan rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const [, g] of entries) g.state = "abandoned";
    ghostsDirty = true;
    gate.prune();
    schedulePatch();
  }

  /**
   * A write landed on a ghost path. While a run is active the write
   * is attributed to the worker (single-worker v1) and solidifies as
   * intended — but only when the gate binds it; the observed
   * file-written event (applied just before this hook) stands as
   * the record either way. With no run active, the write is not the
   * worker's: the ghost resolves as superseded (D20), never
   * agent-solid.
   */
  function solidifyGhost(path: string) {
    const g = ghosts.get(path);
    if (!g) return;
    ghosts.delete(path);
    ghostsDirty = true;
    schedulePatch();
    if (g.state !== "planned" || !activeRun || g.planId !== activePlanId) return;
    try {
      const event = validateFloorEvent({
        v: EVENTS_VERSION,
        id: crypto.randomUUID(),
        ts: Date.now(),
        sessionId: g.sessionId,
        agentId: MUSE_AGENT_ID,
        type: "file-written",
        provenance: "intended",
        path,
        planId: g.planId,
        by: "agent",
      });
      const verdict = ingestAgentEvent(event);
      if (verdict.verdict !== "bound") {
        console.error(
          `warn: solidify for ${path} unbound (${verdict.verdict === "unbound" ? verdict.reason : verdict.verdict}); observed record stands`,
        );
      }
    } catch (err) {
      console.error(`warn: solidify event rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Rebuild the gate and ghosts from the durable log after boot
   * (T4: the ghost layer reads intent it saw before a relaunch).
   * Loaded intended writes are checked through the gate's rebuild
   * verdicts, never trusted for merely being on disk.
   */
  function rebuildGhostsFromLog() {
    const verdicts = gate.rebuild(eventLog);
    eventLog.forEach((event, i) => {
      if (event.type === "planned") {
        const stepsByPath = new Map<string, string>();
        for (const step of event.steps ?? []) {
          for (const p of extractPathsFromText(step)) {
            if (!stepsByPath.has(p)) stepsByPath.set(p, step);
          }
        }
        for (const p of event.paths) {
          // Already solid before relaunch (or a modify-plan for an
          // existing file): a restart keeps create-intent only.
          if (buildings.has(p)) continue;
          ghosts.set(p, {
            planId: event.planId,
            sessionId: event.sessionId ?? agentSessionId,
            step: stepsByPath.get(p),
            state: "planned",
          });
        }
        planActivity.set(event.planId, event.ts);
      } else if (event.type === "file-written") {
        if (event.provenance === "intended" && verdicts[i]?.verdict === "bound") ghosts.delete(event.path);
      } else if (event.type === "abandoned-plan") {
        for (const p of event.paths) {
          const g = ghosts.get(p);
          if (g && g.planId === event.planId) g.state = "abandoned";
        }
      }
    });
    for (const path of ghosts.keys()) assignBuilding(layout, path);
    if (ghosts.size > 0) ghostsDirty = true;
  }

  function handleAgentLine(planId: string, event: MuseStreamEvent) {
    if (closed || planId !== activePlanId) return;
    planActivity.set(planId, Date.now());
    if (event.kind === "activity") {
      // Gate activity refresh: one observed heartbeat per window is
      // enough to keep the plan binding without flooding the log.
      const now = Date.now();
      if (now - lastHeartbeatTs >= AGENT_HEARTBEAT_MS) {
        lastHeartbeatTs = now;
        try {
          ingestAgentEvent(validateFloorEvent({
            v: EVENTS_VERSION,
            id: crypto.randomUUID(),
            ts: now,
            sessionId: runSessionId,
            agentId: MUSE_AGENT_ID,
            type: "started",
            provenance: "observed",
            ...(agentStatus.step ? { step: agentStatus.step.slice(0, MAX_TEXT_CHARS) } : {}),
          }));
        } catch { /* heartbeat is best-effort */ }
      }
      return;
    }
    if (event.kind !== "todo") return;
    if (event.sessionId) runSessionId = event.sessionId;
    const stepsByPath = new Map<string, string>();
    for (const item of event.items) {
      if (item.status === "completed" || item.status === "cancelled") continue;
      for (const p of extractPathsFromText(item.text)) {
        if (!stepsByPath.has(p)) stepsByPath.set(p, item.text);
      }
    }
    const planned = plannedEventFromTodo({
      sessionId: runSessionId,
      planId,
      items: event.items,
      ts: Date.now(),
      id: crypto.randomUUID(),
    });
    if (planned) {
      ingestAgentEvent(planned);
      upsertGhosts(planId, runSessionId, stepsByPath);
    }
    const step = currentStep(event.items);
    setAgentStatus({
      agentId: MUSE_AGENT_ID,
      state: "working",
      sessionId: agentSessionId,
      ...(step ? { step: step.slice(0, 200) } : {}),
    });
  }

  function handleAgentExit(planId: string, info: { code: number | null; timedOut: boolean; sawTerminal: boolean }) {
    if (planId !== activePlanId) return;
    activeRun = undefined;
    activePlanId = undefined;
    abandonPlan(planId);
    if (stopRequested) {
      setAgentStatus({ agentId: MUSE_AGENT_ID, state: "done", sessionId: agentSessionId, detail: "stopped" });
    } else if (info.timedOut) {
      setAgentStatus({ agentId: MUSE_AGENT_ID, state: "error", sessionId: agentSessionId, detail: "timed out" });
      broadcast({ v: WIRE_VERSION, type: "notice", text: "Agent timed out and was killed." });
    } else if (info.code === 0 && info.sawTerminal) {
      setAgentStatus({ agentId: MUSE_AGENT_ID, state: "done", sessionId: agentSessionId });
    } else {
      const tail = maskContent(stderrTail).content.trim().split("\n").filter(Boolean).pop() ?? "";
      const detail = `exit ${info.code ?? "?"}${tail ? `: ${tail.slice(0, 200)}` : ""}`;
      setAgentStatus({ agentId: MUSE_AGENT_ID, state: "error", sessionId: agentSessionId, detail });
      broadcast({ v: WIRE_VERSION, type: "notice", text: `Agent exited with an error (${detail}).` });
    }
  }

  function startDispatch(ws: ServerWebSocket<SocketData>, rawText: string) {
    const text = rawText.trim();
    if (!agentOpts) {
      send(ws, { v: WIRE_VERSION, type: "notice", text: "Dispatch needs an agent session — no agent connected (this floor was started with --agent none)." });
      return;
    }
    if (text.length === 0) {
      send(ws, { v: WIRE_VERSION, type: "notice", text: "Type a prompt first." });
      return;
    }
    if (activeRun) {
      send(ws, { v: WIRE_VERSION, type: "notice", text: "The agent is already working — stop it first." });
      return;
    }
    const command = agentOpts.command ?? "muse";
    if (!agentOpts.spawnFn && !Bun.which(command)) {
      // Blocked state, stated plainly (never a silent no-op).
      setAgentStatus({ agentId: MUSE_AGENT_ID, state: "error", sessionId: agentSessionId, detail: `${command} not found on PATH` });
      send(ws, { v: WIRE_VERSION, type: "notice", text: `Cannot dispatch: ${command} not found on PATH. Install Muse Code or pass --agent-bin <path>.` });
      return;
    }
    // A fresh dispatch supersedes yesterday's abandoned outlines.
    for (const [p, g] of ghosts) if (g.state === "abandoned") ghosts.delete(p);
    ghostsDirty = true;
    const planId = crypto.randomUUID();
    activePlanId = planId;
    runSessionId = agentSessionId;
    stopRequested = false;
    stderrTail = "";
    lastHeartbeatTs = 0;
    planActivity.set(planId, Date.now());
    try {
      // The logged copy is masked and truncation is visible; the
      // agent receives the original text (D16/D18).
      const masked = maskContent(text).content;
      const logged = masked.length > MAX_TEXT_CHARS ? `${masked.slice(0, MAX_TEXT_CHARS - 1)}…` : masked;
      ingestAgentEvent(validateFloorEvent({
        v: EVENTS_VERSION,
        id: crypto.randomUUID(),
        ts: Date.now(),
        sessionId: runSessionId,
        agentId: MUSE_AGENT_ID,
        type: "prompt-sent",
        provenance: "observed",
        text: logged,
      }));
    } catch (err) {
      console.error(`warn: prompt-sent rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    setAgentStatus({ agentId: MUSE_AGENT_ID, state: "working", sessionId: agentSessionId });
    try {
      activeRun = startMuseRun({
        workspace: repo,
        sessionId: agentSessionId,
        prompt: text,
        command: agentOpts.command,
        spawnFn: agentOpts.spawnFn,
        timeoutMs: agentOpts.timeoutMs,
        callbacks: {
          onLine: (event) => enqueue(async () => handleAgentLine(planId, event)),
          onStderr: (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-512);
          },
          onExit: (info) => enqueue(async () => handleAgentExit(planId, info)),
        },
      });
    } catch (err) {
      activeRun = undefined;
      activePlanId = undefined;
      const message = err instanceof Error ? err.message : String(err);
      setAgentStatus({ agentId: MUSE_AGENT_ID, state: "error", sessionId: agentSessionId, detail: message });
      broadcast({ v: WIRE_VERSION, type: "notice", text: `Agent failed to start: ${message}` });
    }
  }

  type FileMeta = { size: number; mtimeMs: number; lines: number; binary: boolean; text?: string };

  /**
   * Read one file's floor metadata. One containment policy for every
   * server read: symlinks escaping the repo are skipped entirely,
   * exactly as open-file refuses them (never sized or parsed either).
   */
  async function readFileMeta(path: string): Promise<FileMeta | undefined> {
    const resolved = resolveInsideRepo(repo, path);
    if (!resolved.ok) return undefined;
    const absolute = resolved.absolute;
    let size: number;
    let mtimeMs = 0;
    try {
      const s = statSync(absolute);
      if (!s.isFile()) return undefined;
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch {
      return undefined;
    }
    // Env files and aliases to them: stat-only metadata. Their
    // contents are never read or parsed, so no line structure or
    // parse error derived from secret content can leave the server.
    if (isEnvFile(path) || isEnvFile(absolute)) {
      return { size, mtimeMs, lines: 0, binary: false };
    }
    // Reads race the stat above: a file can vanish, be replaced, or
    // be unreadable (chmod 000). One bad file yields no building; it
    // must never abort boot or the change batch around it.
    try {
      // Slice, never trust the stat: a file that grew between stat
      // and read takes the big-file path instead of blowing the
      // batch's memory bound with an unbounded read.
      const buf = new Uint8Array(await Bun.file(absolute).slice(0, MAX_PARSE_BYTES + 1).arrayBuffer());
      if (size > MAX_PARSE_BYTES || buf.length > MAX_PARSE_BYTES) {
        const binary = buf.subarray(0, 8192).includes(0);
        return { size, mtimeMs, lines: binary ? 0 : await countNewlines(absolute), binary };
      }
      if (isBinaryBuffer(buf)) return { size, mtimeMs, lines: 0, binary: true };
      // Retain text only for files the parser will actually receive:
      // holding every md/json/lockfile body in a boot chunk is an
      // unbounded-bytes memory spike against the 150 MiB budget.
      const parseable = languageForPath(path) !== undefined;
      return {
        size,
        mtimeMs,
        lines: countBufferLines(buf),
        binary: false,
        ...(parseable ? { text: new TextDecoder().decode(buf) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  function toBuilding(path: string, meta: FileMeta, result?: ParseResult): Building | undefined {
    const placed = layout.buildings[path];
    if (!placed) return undefined;
    return {
      id: placed.id,
      path,
      zoneId: placed.zoneId,
      x: placed.x,
      y: placed.y,
      band: bandForFile(meta.lines, meta.size, meta.binary),
      lines: meta.lines,
      bytes: meta.size,
      mtimeMs: meta.mtimeMs,
      binary: meta.binary,
      parse: result ? parseStateForResult(result) : "unparsed",
      ...(result?.error ? { parseError: result.error } : {}),
      unresolvedCount: beltsByPath.get(path)?.unresolved ?? 0,
      ...(connByPath.get(path) ? { conn: connByPath.get(path) } : {}),
    };
  }

  /** Pre-read batch input: null when the pre-pass found nothing readable. */
  type Prebuilt = { meta: FileMeta; result?: ParseResult } | null;

  async function buildBuilding(path: string, pre: Prebuilt): Promise<Building | undefined> {
    const meta = pre?.meta;
    if (!meta) return undefined;
    const result: ParseResult | undefined = pre?.result;
    // A failed parse keeps the file's last good imports/parse info:
    // transient syntax errors dim the lamp without erasing the belts.
    noteParseResult(path, result);
    return toBuilding(path, meta, result);
  }

  // isConfigFile/isInitPy/affectsContext live at module scope (slice 6).

  function readConfigText(path: string): string | undefined {
    const resolved = resolveInsideRepo(repo, path);
    if (!resolved.ok) return undefined;
    try {
      const s = statSync(resolved.absolute);
      if (!s.isFile() || s.size > 256 * 1024) return undefined;
      return readFileSync(resolved.absolute, "utf8");
    } catch {
      return undefined;
    }
  }

  function rebuildResolverContext() {
    resolverCtxByLabel.clear();
    for (const label of labels) {
      syncRelFiles(label);
      const relFiles = relFilesByLabel.get(label)!;
      const jvm = buildJvmIndex(
        [...parseInfoByPath.entries()]
          .filter(([path]) => splitPrefixed(path).label === label)
          .map(([path, info]) => ({ path: splitPrefixed(path).rel, packageName: info.packageName, declaredTypes: info.declaredTypes })),
      );
      resolverCtxByLabel.set(label, {
        ...buildResolverContext(relFiles, (p) => (isConfigFile(p) ? readConfigText(prefixedPath(label, p)) : undefined), jvm),
        isExcluded: (p) => isExcluded(prefixedPath(label, p)),
      });
    }
    jvmIndexStale = false;
  }

  function resolveOne(path: string) {
    const next = resolveForPath(path);
    const prev = beltsByPath.get(path);
    beltsByPath.set(path, next);
    if (!prev || prev.unresolved !== next.unresolved || prev.targets.join("\0") !== next.targets.join("\0")) {
      beltsDirty = true;
    }
  }

  function resolveAll() {
    for (const path of buildings.keys()) {
      beltsByPath.set(path, resolveForPath(path));
    }
    for (const path of [...beltsByPath.keys()]) {
      if (!buildings.has(path)) beltsByPath.delete(path);
    }
  }

  /** Re-stamp a just-built building with post-resolution counts. */
  function withFreshUnresolved(b: Building): Building {
    return { ...b, unresolvedCount: beltsByPath.get(b.path)?.unresolved ?? 0 };
  }

  function snapshotCounts(): Map<string, number> {
    return new Map([...buildings].map(([p, b]) => [p, b.unresolvedCount] as [string, number]));
  }

  /** Upsert buildings whose unresolved count changed under a resolveAll. */
  function refreshCounts(before: Map<string, number>) {
    for (const [path, b] of buildings) {
      const now = beltsByPath.get(path)?.unresolved ?? 0;
      if (before.get(path) !== now) {
        const fresh = { ...b, unresolvedCount: now };
        buildings.set(path, fresh);
        pending.upsert.set(path, fresh);
      }
    }
  }

  /** Live belt edges over stable ids; unbuilt targets are skipped. */
  function currentBelts(): BeltEdge[] {
    const idByPath = new Map<string, string>();
    for (const [path, b] of buildings) idByPath.set(path, b.id);
    const seen = new Set<string>();
    const edges: BeltEdge[] = [];
    for (const [fromPath, belts] of beltsByPath) {
      const fromId = idByPath.get(fromPath);
      if (!fromId) continue;
      for (const target of belts.targets) {
        const toId = idByPath.get(target);
        if (!toId) continue;
        const key = `${fromId}\0${toId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ fromId, toId });
      }
    }
    // Contract belts: matched HTTP calls and shared-topic
    // produce->consume pairs from the connection graph. These are
    // the only cross-repo edges ever drawn (never inferred).
    const matchedToPath = (s: string): string => {
      const sepAt = s.indexOf(":");
      if (sepAt === -1) return s;
      return prefixedPath(s.slice(0, sepAt), s.slice(sepAt + 1));
    };
    for (const b of buildings.values()) {
      const conn = b.conn;
      if (!conn) continue;
      for (const call of conn.calls) {
        if (!call.matchedPath) continue;
        const toId = idByPath.get(matchedToPath(call.matchedPath));
        if (!toId || toId === b.id) continue;
        const key = `${b.id}\0${toId}\0http`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ fromId: b.id, toId, kind: "http" });
      }
      for (const topic of conn.topics) {
        if (topic.direction !== "produce") continue;
        for (const peer of topic.peers) {
          const toId = idByPath.get(matchedToPath(peer));
          if (!toId || toId === b.id) continue;
          const key = `${b.id}\0${toId}\0topic`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ fromId: b.id, toId, kind: "topic" });
        }
      }
    }
    edges.sort((a, b) =>
      a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : (a.kind ?? "") < (b.kind ?? "") ? -1 : (a.kind ?? "") > (b.kind ?? "") ? 1 : 0,
    );
    return edges;
  }

  // Zone counts describe rendered buildings, not layout entries: a
  // slot reserved for a currently unreadable file keeps its place
  // (and pad geometry) without inflating the machine count.
  function snapshotZones() {
    const counts = new Map<string, number>();
    for (const b of buildings.values()) counts.set(b.zoneId, (counts.get(b.zoneId) ?? 0) + 1);
    // A zone holding only ghosts must still reach the client, or
    // those ghosts would float without a pad to sit on.
    const ghostZones = new Set<string>();
    for (const p of ghosts.keys()) {
      const placed = layout.buildings[p];
      if (placed) ghostZones.add(placed.zoneId);
    }
    return zoneRects(layout)
      .map((z) => ({ ...z, fileCount: counts.get(z.id) ?? 0 }))
      .filter((z) => z.fileCount > 0 || ghostZones.has(z.id));
  }

  function snapshotMessage(): ServerMessage {
    return {
      v: WIRE_VERSION,
      type: "snapshot",
      stateVersion: version,
      repo: multi ? labels.join(" + ") : basename(repo),
      zones: snapshotZones(),
      buildings: [...buildings.values()],
      belts: currentBelts(),
      total: buildings.size,
      watcher: watcherState,
      ghosts: currentGhosts(),
      agent: agentStatus,
    };
  }

  function send(ws: ServerWebSocket<SocketData>, message: ServerMessage) {
    ws.send(JSON.stringify(message));
  }

  function broadcast(message: ServerMessage) {
    for (const ws of sockets) if (ws.data.authed) send(ws, message);
  }

  // --- patch batching -------------------------------------------------
  const pending = {
    upsert: new Map<string, Building>(),
    remove: new Set<string>(),
    rename: [] as { id: string; from: string; to: string }[],
    force: false,
  };
  let patchTimer: ReturnType<typeof setTimeout> | undefined;

  function schedulePatch(force = false) {
    if (closed) return;
    if (force) pending.force = true;
    if (patchTimer) return;
    patchTimer = setTimeout(() => {
      patchTimer = undefined;
      if (
        pending.upsert.size === 0 && pending.remove.size === 0 && pending.rename.length === 0
        && !pending.force && !beltsDirty && !ghostsDirty && !agentDirty
      ) return;
      pending.force = false;
      version += 1;
      const belts = beltsDirty ? currentBelts() : undefined;
      const patchGhosts = ghostsDirty ? currentGhosts() : undefined;
      const patchAgent = agentDirty ? agentStatus : undefined;
      beltsDirty = false;
      ghostsDirty = false;
      agentDirty = false;
      broadcast({
        v: WIRE_VERSION,
        type: "patch",
        stateVersion: version,
        upsert: [...pending.upsert.values()],
        remove: [...pending.remove],
        rename: pending.rename,
        ...(belts !== undefined ? { belts } : {}),
        ...(patchGhosts !== undefined ? { ghosts: patchGhosts } : {}),
        ...(patchAgent !== undefined ? { agent: patchAgent } : {}),
        zones: snapshotZones(),
        total: buildings.size,
        watcher: watcherState,
      });
      pending.upsert.clear();
      pending.remove.clear();
      pending.rename = [];
    }, PATCH_BATCH_MS);
  }

  // --- watcher change application (serialized) -------------------------
  let chain: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>) {
    // A failed task must be visible, never silently swallowed.
    chain = chain.then(task, task).catch((err: unknown) => {
      console.error(`warn: change pipeline error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // A zone's column count is fixed at creation from an initial file
  // count. Batches that introduce a brand-new folder must size it
  // from the whole batch, not from the first file to arrive.
  function newZoneCounts(changes: readonly WatchChange[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const change of changes) {
      if (change.kind !== "created" && change.kind !== "renamed") continue;
      const zoneId = zoneOf(change.path);
      if (!layout.zones[zoneId]) counts.set(zoneId, (counts.get(zoneId) ?? 0) + 1);
    }
    return counts;
  }

  /** Shared batch state: one resolveAll runs at batch end, not per change. */
  type BatchCtx = {
    needsResolveAll: boolean;
    prebuilt: Map<string, Prebuilt>;
  };

  async function applyChange(change: WatchChange, zoneCounts: ReadonlyMap<string, number>, batch: BatchCtx) {
    const zoneInitialCount = zoneCounts.get(zoneOf(change.path)) ?? 1;
    if (change.kind === "deleted") {
      const existing = buildings.get(change.path);
      buildings.delete(change.path);
      // A deleted path's ghost (a modify-plan for it) is gone too.
      if (ghosts.delete(change.path)) {
        ghostsDirty = true;
        schedulePatch();
      }
      removeBuilding(layout, change.path);
      pending.upsert.delete(change.path);
      trackKnown(change.path, false);
      importsByPath.delete(change.path);
      parseInfoByPath.delete(change.path);
      dropConnections(change.path);
      beltsByPath.delete(change.path);
      // A deleted config (or __init__.py) rebuilds the context
      // even when it has no building of its own; otherwise removed
      // aliases and stale package roots keep resolving.
      const ctxGone = affectsContext(change);
      if (ctxGone) rebuildResolverContext();
      if (existing) pending.remove.add(existing.id);
      if (existing || ctxGone) {
        // Importers of the deleted path now dangle: re-resolve all
        // so their counts stay truthful.
        batch.needsResolveAll = true;
      }
      emitEvent({ type: "observed-change", provenance: "observed", path: change.path, change: "deleted" });
      return;
    }
    if (change.kind === "renamed") {
      const placed = renameBuilding(layout, change.fromPath, change.path, { zoneInitialCount });
      buildings.delete(change.fromPath);
      pending.upsert.delete(change.fromPath);
      trackKnown(change.fromPath, false);
      trackKnown(change.path, true);
      // Carry last-good imports to the new path (a failed parse keeps
      // them, like a plain edit); the rebuild below overwrites on ok.
      const carried = importsByPath.get(change.fromPath);
      importsByPath.delete(change.fromPath);
      if (carried !== undefined) importsByPath.set(change.path, carried);
      const carriedInfo = parseInfoByPath.get(change.fromPath);
      parseInfoByPath.delete(change.fromPath);
      if (carriedInfo !== undefined) parseInfoByPath.set(change.path, carriedInfo);
      const carriedConn = connectionsByPath.get(change.fromPath);
      connectionsByPath.delete(change.fromPath);
      if (carriedConn !== undefined) {
        connectionsByPath.set(change.path, { ...carriedConn, path: change.path });
        connectionsDirty = true;
      }
      connByPath.delete(change.fromPath);
      beltsByPath.delete(change.fromPath);
      if (placed) pending.rename.push({ id: placed.id, from: change.fromPath, to: change.path });
      else {
        // Unknown source: evict any occupant so the target is
        // assigned fresh instead of inheriting a stale entry's id.
        removeBuilding(layout, change.path);
        assignBuilding(layout, change.path, { zoneInitialCount });
      }
      emitEvent({ type: "observed-change", provenance: "observed", path: change.path, change: "renamed", fromPath: change.fromPath });
      const b = await buildBuilding(change.path, batch.prebuilt.get(change.path) ?? null);
      // Paths changed on both ends of every edge: re-resolve all.
      // The rebuilt file stores tentatively first so the batch-end
      // resolveAll sees its own outgoing edges too.
      if (affectsContext(change)) rebuildResolverContext();
      if (b) buildings.set(change.path, b);
      batch.needsResolveAll = true;
      if (b) {
        const fresh = withFreshUnresolved(b);
        buildings.set(change.path, fresh);
        pending.upsert.set(change.path, fresh);
      } else {
        // Rebuild failed (e.g. file vanished mid-rename): tell clients
        // to drop the building, but keep its slot/id reserved so a
        // later readable state returns to the same place.
        if (placed) pending.remove.add(placed.id);
        importsByPath.delete(change.path);
        parseInfoByPath.delete(change.path);
        dropConnections(change.path);
      }
      return;
    }
    if (!layout.buildings[change.path]) {
      assignBuilding(layout, change.path, { zoneInitialCount });
    }
    trackKnown(change.path, true);
    const existing = buildings.get(change.path);
    const b = await buildBuilding(change.path, batch.prebuilt.get(change.path) ?? null);
    // Belt refresh: config edits rebuild the context and re-resolve
    // everything; created files can complete others' dangling refs;
    // plain modifications only affect their own file. The batch-end
    // resolveAll needs the rebuilt file stored first (tentatively).
    if (isConfigFile(change.path) || change.kind === "created") {
      if (b) buildings.set(change.path, b);
      if (affectsContext(change)) rebuildResolverContext();
      batch.needsResolveAll = true;
    } else {
      resolveOne(change.path);
    }
    if (b) {
      const fresh = withFreshUnresolved(b);
      buildings.set(change.path, fresh);
      pending.upsert.set(change.path, fresh);
      if (change.kind === "created") {
        emitEvent({ type: "observed-change", provenance: "observed", path: change.path, change: "created" });
      }
      emitEvent({ type: "file-written", provenance: "observed", path: change.path, by: "unknown" });
      // Ghost layer: a write on a planned path may solidify it (the
      // observed record above always stands; intended is additive).
      solidifyGhost(change.path);
    } else {
      // Keep the layout entry reserved (zone counts come from real
      // buildings, so it cannot inflate them): when the file becomes
      // readable again it returns with the same id and slot instead
      // of drifting to a fresh append slot.
      importsByPath.delete(change.path);
      parseInfoByPath.delete(change.path);
      dropConnections(change.path);
      beltsByPath.delete(change.path);
      beltsDirty = true;
      if (existing) {
        buildings.delete(change.path);
        pending.upsert.delete(change.path);
        pending.remove.add(existing.id);
      }
    }
  }

  /**
   * Apply one watcher batch: a single parser round trip over
   * byte-bounded pre-read groups (boot-chunk discipline — a giant
   * batch must not retain giant texts), ordered application, then at
   * most one resolveAll. Per-change failures stay contained via
   * onError and never lose the rest of the batch.
   */
  async function applyBatch(
    changes: readonly WatchChange[],
    zoneCounts: ReadonlyMap<string, number>,
    onError: (change: WatchChange, err: unknown) => void,
  ): Promise<void> {
    if (changes.length === 0) return;
    const prebuilt = new Map<string, Prebuilt>();
    const seen = new Set<string>();
    const GROUP_BYTES = 8 * 1024 * 1024;
    let group: { path: string; meta: FileMeta }[] = [];
    let groupBytes = 0;
    const flushGroup = async () => {
      if (group.length === 0) return;
      const texts = group.filter((g) => g.meta.text !== undefined);
      const results = new Map(
        (
          await parser.parse(texts.map((g) => ({ path: g.path, content: g.meta.text! })))
        ).map((r) => [r.path, r]),
      );
      for (const { path, meta } of group) {
        const record = { meta, result: results.get(path) };
        noteConnections(path, meta.text);
        meta.text = undefined; // retained bytes return before the next group
        prebuilt.set(path, record);
      }
      group = [];
      groupBytes = 0;
    };
    for (const change of changes) {
      if (change.kind === "deleted" || seen.has(change.path)) continue;
      seen.add(change.path);
      const meta = await readFileMeta(change.path);
      if (!meta) {
        prebuilt.set(change.path, null);
        continue;
      }
      group.push({ path: change.path, meta });
      groupBytes += meta.text?.length ?? 0;
      if (groupBytes >= GROUP_BYTES) await flushGroup();
    }
    await flushGroup();
    const batch: BatchCtx = { needsResolveAll: false, prebuilt };
    for (const change of changes) {
      try {
        await applyChange(change, zoneCounts, batch);
      } catch (err) {
        onError(change, err);
      }
    }
    // A content edit that changed a JVM file's package or declared
    // types moved FQN targets: rebuild the index and re-resolve all.
    if (jvmIndexStale) {
      rebuildResolverContext();
      batch.needsResolveAll = true;
    }
    if (batch.needsResolveAll) {
      const before = snapshotCounts();
      resolveAll();
      refreshCounts(before);
      beltsDirty = true;
      // Per-change tentative stores above read pre-resolve counts;
      // re-fresh everything queued so buildings and pending agree.
      for (const [path, b] of pending.upsert) {
        const fresh = withFreshUnresolved(b);
        buildings.set(path, fresh);
        pending.upsert.set(path, fresh);
      }
    }
    if (connectionsDirty) recomputeConnections();
  }

  // --- static assets (before boot/watcher: a bundle failure must
  // not leak a running watcher or parser subprocess) -----------------
  const uiDir = join(import.meta.dir, "..", "floor-ui");
  const htmlTemplate = await Bun.file(join(uiDir, "index.html")).text();
  const css = await Bun.file(join(uiDir, "styles.css")).text();
  // Bundle in a short-lived subprocess: the in-process bundler retains
  // ~10 MiB of transpiler state against the 150 MiB process budget
  // (measured; see issue #2 measurement comment).
  const bundleProc = Bun.spawnSync([process.execPath, "build", join(uiDir, "app.ts"), "--target", "browser"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (bundleProc.exitCode !== 0) {
    throw new Error(`floor-ui bundle failed: ${bundleProc.stderr.toString().trim().slice(0, 400)}`);
  }
  const appJs = bundleProc.stdout.toString();
  const html = htmlTemplate.replace("%ARTIFEX_TOKEN%", token);

  // --- boot ------------------------------------------------------------
  const files = listAllFiles();
  for (const path of files) trackKnown(path, true);
  rebuildResolverContext();
  const persisted = loadPersistedLayout(repo);
  if (persisted.layout) {
    layout = persisted.layout;
    const onDisk = new Set(files);
    for (const path of Object.keys(layout.buildings)) {
      if (!onDisk.has(path)) removeBuilding(layout, path);
    }
    // Size zones that are new since the persisted layout from their
    // full on-disk counts, not from the first file assigned.
    const freshZoneCounts = new Map<string, number>();
    for (const path of files) {
      const zoneId = zoneOf(path);
      if (!layout.zones[zoneId]) freshZoneCounts.set(zoneId, (freshZoneCounts.get(zoneId) ?? 0) + 1);
    }
    for (const path of files) {
      assignBuilding(layout, path, { zoneInitialCount: freshZoneCounts.get(zoneOf(path)) ?? 1 });
    }
  } else {
    layout = layoutFloor(files);
  }
  // Boot parse is batched (not one parser round trip per file), in
  // chunks bounded by BOTH file count and retained text bytes, so a
  // run of near-1MiB files can never hold hundreds of MiB at once.
  const BOOT_CHUNK_FILES = 256;
  const BOOT_CHUNK_TEXT_BYTES = 8 * 1024 * 1024;
  let chunkMetas = new Map<string, FileMeta>();
  let chunkTextBytes = 0;
  const flushChunk = async () => {
    if (chunkMetas.size === 0) return;
    const parseables = [...chunkMetas.entries()].filter(([, m]) => m.text !== undefined);
    const results = new Map(
      (await parser.parse(parseables.map(([path, m]) => ({ path, content: m.text! })))).map((r) => [r.path, r]),
    );
    for (const [path, meta] of chunkMetas) {
      const parsed = results.get(path);
      noteConnections(path, meta.text);
      if (parsed?.ok) noteParseResult(path, parsed);
      resolveOne(path);
      const b = toBuilding(path, meta, results.get(path));
      if (b) buildings.set(path, b);
    }
    chunkMetas = new Map();
    chunkTextBytes = 0;
  };
  for (const path of files) {
    const meta = await readFileMeta(path);
    if (!meta) {
      // Slot stays reserved; the watcher baseline below excludes
      // unbuilt paths so a later readable state is re-detected.
      bootSkipped++;
      continue;
    }
    chunkMetas.set(path, meta);
    chunkTextBytes += meta.text?.length ?? 0;
    if (chunkMetas.size >= BOOT_CHUNK_FILES || chunkTextBytes >= BOOT_CHUNK_TEXT_BYTES) await flushChunk();
  }
  await flushChunk();
  // The JVM index only exists once boot parsing has run: rebuild the
  // context over the collected parse info and re-resolve everything,
  // so first-snapshot belts are final, not chunk-order artifacts.
  rebuildResolverContext();
  resolveAll();
  for (const [path, b] of buildings) buildings.set(path, withFreshUnresolved(b));
  recomputeConnections(true);
  if (bootSkipped > 0) {
    console.error(`warn: ${bootSkipped} file(s) could not be read at boot and are not shown`);
  }
  watcherState = "watching";
  saveLayout();

  const watcher: WatcherHandle = watchRepo(
    repo,
    files,
    (changes) => enqueue(async () => {
      const zoneCounts = newZoneCounts(changes);
      await applyBatch(changes, zoneCounts, (change, err) => {
        console.error(`warn: change ${change.kind} ${change.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      for (const change of changes) {
        // A path with no building must not stay in the watcher
        // baseline: with size/mtime unchanged (e.g. chmod fixing an
        // unreadable file) no later diff would ever re-detect it.
        if (change.kind === "deleted" || !buildings.has(change.path)) watcher.known.delete(change.path);
        if (change.kind === "renamed") watcher.known.delete(change.fromPath);
      }
      saveLayout();
      schedulePatch();
    }),
    (state) => {
      watcherState = state;
      schedulePatch(true);
    },
    multi
      ? { listFiles: listAllFiles, includePath: (p) => labels.includes(p.split("/")[0]!) }
      : undefined,
  );
  if (persisted.reset) {
    console.error("warn: floor state was corrupt or incompatible; layout recomputed (old state kept as .bak)");
  }
  // Reconcile the boot window: files changed between the boot reads
  // and the watcher's baseline snapshot are invisible to a plain
  // known-vs-current diff, so also compare against built buildings.
  enqueue(async () => {
    const current = snapshotMeta(repo, listAllFiles());
    const plan = planReconcile(watcher.known, current, buildings);
    const onError = (change: WatchChange, err: unknown) => {
      console.error(`warn: reconcile ${change.kind} ${change.path} failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    // Later groups observe earlier groups' buildings, so each group
    // is its own batch (still one resolveAll per group at most).
    for (const group of plan.groups) {
      await applyBatch(group, newZoneCounts(group), onError);
    }
    syncReconcileBaseline(watcher.known, current, buildings, plan.handled);
    // Ghost layer: restore intent seen before this relaunch from
    // the durable log (gate-checked, never trusted on disk alone).
    rebuildGhostsFromLog();
    saveLayout();
    schedulePatch();
  });

  // Idle expiry sweep (D7/D20): a planned ghost with no session
  // activity past the window is abandoned — emitted, dashed, and
  // left visible as an abandoned outline rather than silently cut.
  const ghostSweep = setInterval(() => {
    enqueue(async () => {
      const now = Date.now();
      const plans = new Set(
        [...ghosts.values()].filter((g) => g.state === "planned").map((g) => g.planId),
      );
      for (const planId of plans) {
        if (now - (planActivity.get(planId) ?? now) > agentIdleTimeoutMs) abandonPlan(planId);
      }
      gate.prune();
    });
  }, agentOpts?.sweepMs ?? GHOST_SWEEP_MS);

  function hostAllowed(req: Request): boolean {
    const host = req.headers.get("host");
    if (!host) return false;
    const port = new URL(req.url).port;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  function originAllowed(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true; // non-browser clients still need the token
    const port = new URL(req.url).port;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }

  async function handleOpenFile(ws: ServerWebSocket<SocketData>, path: unknown) {
    if (typeof path !== "string") {
      send(ws, { v: WIRE_VERSION, type: "error", code: "bad-path", message: "path must be a string" });
      return;
    }
    if (isEnvFile(path)) {
      send(ws, { v: WIRE_VERSION, type: "error", code: "masked-file", message: "env files are never rendered" });
      return;
    }
    const resolved = resolveInsideRepo(repo, path);
    if (!resolved.ok) {
      send(ws, { v: WIRE_VERSION, type: "error", code: resolved.code, message: resolved.code === "bad-path" ? "path escapes the repo" : "file not found" });
      return;
    }
    // The requested name can alias an env file (symlink, case variant):
    // the resolved target's basename must pass the same env check.
    if (isEnvFile(resolved.absolute)) {
      send(ws, { v: WIRE_VERSION, type: "error", code: "masked-file", message: "env files are never rendered" });
      return;
    }
    // Only floor buildings are previewable. Containment alone would
    // also serve excluded paths (.git/config, build output, state)
    // that the floor never shows and masking was not designed for.
    const resolvedRel = relative(realpathSync(repo), resolved.absolute).split(sep).join("/");
    if (isExcluded(path) || isExcluded(resolvedRel) || !buildings.has(path)) {
      send(ws, { v: WIRE_VERSION, type: "error", code: "not-found", message: "file not found" });
      return;
    }
    let size: number;
    let buf: Uint8Array;
    try {
      const s = statSync(resolved.absolute);
      if (!s.isFile()) throw new Error("not a file");
      size = s.size;
      buf = new Uint8Array(await Bun.file(resolved.absolute).slice(0, Math.min(size, 512 * 1024)).arrayBuffer());
    } catch {
      send(ws, { v: WIRE_VERSION, type: "error", code: "not-found", message: "file not found" });
      return;
    }
    const readBytes = buf.length;
    // A byte-capped prefix may end inside a multibyte character;
    // that alone must not classify a text file as binary.
    const text = size > readBytes
      ? decodeUtf8Prefix(buf)
      : isBinaryBuffer(buf) ? undefined : new TextDecoder().decode(buf);
    if (text === undefined) {
      send(ws, { v: WIRE_VERSION, type: "error", code: "binary-file", message: "binary file, no preview" });
      return;
    }
    const { content, masked } = maskContent(text);
    const truncated = size > readBytes || content.length > CONTENT_CAP;
    send(ws, {
      v: WIRE_VERSION,
      type: "file-content",
      path,
      content: content.slice(0, CONTENT_CAP),
      truncated,
      masked,
    });
  }

  function handleMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { v: WIRE_VERSION, type: "error", code: "bad-message", message: "invalid JSON" });
      return;
    }
    if (!msg || typeof msg !== "object" || msg.v !== WIRE_VERSION) {
      send(ws, { v: WIRE_VERSION, type: "error", code: "bad-message", message: "unsupported message version" });
      return;
    }
    if (!ws.data.authed) {
      if (msg.type === "auth" && typeof (msg as { token?: unknown }).token === "string" && (msg as { token: string }).token === token) {
        ws.data.authed = true;
        const timer = authTimers.get(ws);
        if (timer !== undefined) {
          clearTimeout(timer);
          authTimers.delete(ws);
        }
        send(ws, { v: WIRE_VERSION, type: "auth-ok", stateVersion: version });
        send(ws, snapshotMessage());
        if (persisted.reset) send(ws, { v: WIRE_VERSION, type: "notice", text: "floor relaid out: saved state was reset" });
        // Ghost-reserved slots are shown (as ghosts); they are not
        // unreadable files and must not inflate this notice.
        const unbuilt = Object.keys(layout.buildings).filter((p) => !buildings.has(p) && !ghosts.has(p)).length;
        if (unbuilt > 0) send(ws, { v: WIRE_VERSION, type: "notice", text: `${unbuilt} unreadable file(s) not shown` });
      } else {
        send(ws, { v: WIRE_VERSION, type: "error", code: "bad-auth", message: "first message must be a valid auth" });
        ws.close(4001, "bad auth");
      }
      return;
    }
    switch (msg.type) {
      case "resync":
        send(ws, snapshotMessage());
        break;
      case "open-file":
        void handleOpenFile(ws, (msg as { path?: unknown }).path).catch((err: unknown) => {
          console.error(`warn: open-file failed: ${err instanceof Error ? err.message : String(err)}`);
          try {
            send(ws, { v: WIRE_VERSION, type: "error", code: "not-found", message: "file not found" });
          } catch { /* socket already gone */ }
        });
        break;
      case "relayout": {
        // Serialized with change application: relayout must never swap
        // the layout object under an in-flight build, and stale pending
        // upserts must not replay pre-relayout coordinates afterwards.
        enqueue(async () => {
          // Rebuild from built keys plus reserved slots: unreadable
          // files keep their place for a later readable state.
          layout = layoutFloor([...new Set([...buildings.keys(), ...Object.keys(layout.buildings)])], layout);
          for (const [path, b] of buildings) {
            const placed = layout.buildings[path]!;
            buildings.set(path, { ...b, x: placed.x, y: placed.y, zoneId: placed.zoneId });
          }
          pending.upsert.clear();
          pending.remove.clear();
          pending.rename = [];
          version += 1;
          saveLayout();
          broadcast(snapshotMessage());
          broadcast({ v: WIRE_VERSION, type: "notice", text: "floor relaid out" });
        });
        break;
      }
      case "dispatch": {
        // Serialized like relayout: dispatch assigns ghost slots and
        // appends to the event log, so it must not interleave with
        // an in-flight change batch.
        const text = typeof (msg as { text?: unknown }).text === "string" ? (msg as { text: string }).text : "";
        enqueue(async () => startDispatch(ws, text));
        break;
      }
      case "stop-agent":
        if (activeRun) {
          stopRequested = true;
          activeRun.stop();
        }
        break;
      default:
        send(ws, { v: WIRE_VERSION, type: "error", code: "bad-message", message: "unknown message type" });
    }
  }

  let server: Bun.Server<SocketData>;
  try {
    server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: opts.port ?? 4517,
    fetch(req, srv) {
      if (!hostAllowed(req)) return new Response("forbidden host", { status: 403 });
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!originAllowed(req)) return new Response("forbidden origin", { status: 403 });
        if (srv.upgrade(req, { data: { authed: false } })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      // Cross-origin isolation: every asset is same-origin, and it
      // enables performance.measureUserAgentSpecificMemory so the
      // 500 MB tab budget is measured, not estimated.
      const isolation = {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        // The page self-authenticates; never let a foreign page frame
        // it and clickjack controls such as Relayout.
        "content-security-policy": "frame-ancestors 'none'",
        "x-frame-options": "DENY",
      };
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...isolation } });
      }
      if (url.pathname === "/app.js") {
        return new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", ...isolation } });
      }
      if (url.pathname === "/styles.css") {
        return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", ...isolation } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // Client messages are tiny control frames; cap frame size.
      maxPayloadLength: 64 * 1024,
      open(ws) {
        // Bound local FD exhaustion: refuse past the socket cap, and
        // never let an unauthenticated socket idle forever.
        if (sockets.size >= MAX_SOCKETS) {
          ws.close(4002, "too many connections");
          return;
        }
        sockets.add(ws);
        const timer = setTimeout(() => {
          try {
            if (!ws.data.authed) ws.close(4001, "auth timeout");
          } catch {
            /* socket already gone */
          }
        }, AUTH_TIMEOUT_MS);
        if (typeof timer === "object") timer.unref?.();
        authTimers.set(ws, timer);
      },
      message(ws, message) {
        handleMessage(ws, message as string);
      },
      close(ws) {
        sockets.delete(ws);
        const timer = authTimers.get(ws);
        if (timer !== undefined) {
          clearTimeout(timer);
          authTimers.delete(ws);
        }
      },
    },
    });
  } catch (err) {
    // A bind failure must not leak the watcher/parser started above.
    watcher.close();
    parser.terminate();
    throw err;
  }

  if (server.port === undefined) {
    clearInterval(ghostSweep);
    watcher.close();
    parser.terminate();
    server.stop(true);
    throw new Error("server did not bind a TCP port");
  }
  return {
    port: server.port,
    token,
    url: `http://127.0.0.1:${server.port}/`,
    eventLog,
    buildingCount: () => buildings.size,
    ghosts: () => currentGhosts(),
    agentStatus: () => agentStatus,
    stop() {
      closed = true;
      clearInterval(ghostSweep);
      if (activeRun) {
        stopRequested = true;
        activeRun.stop();
        activeRun = undefined;
      }
      if (patchTimer) clearTimeout(patchTimer);
      for (const timer of authTimers.values()) clearTimeout(timer);
      authTimers.clear();
      // Flush a pending save: restart must restore the latest layout.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        persistLayout();
      }
      watcher.close();
      parser.terminate();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // --repo is repeatable: several repos sharing a parent directory
  // federate onto one floor, one district per repo.
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--repo" && args[i + 1]) repos.push(args[i + 1]!);
  if (repos.length === 0) repos.push(process.cwd());
  const repo = repos[0]!;
  const port = Number(flag("--port") ?? "4517");
  // Agent dispatch is on by default (muse on PATH); --agent none
  // runs a watch-only floor, --agent-bin overrides the binary.
  const agentFlag = flag("--agent") ?? "muse";
  const agentBin = flag("--agent-bin") ?? process.env.ARTIFEX_MUSE_BIN;
  createFloorServer({
    repo,
    repos,
    port,
    agent: agentFlag === "none" ? false : { ...(agentBin ? { command: agentBin } : {}) },
  })
    .then((floor) => {
      // Flush the pending layout save on Ctrl-C / service stop;
      // stop() only runs if something calls it.
      const shutdown = () => {
        floor.stop();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      console.log(
        `artifex floor for ${repos.join(" + ")} at ${floor.url} (${floor.buildingCount()} buildings, agent: ${floor.agentStatus().agentId} ${floor.agentStatus().state})`,
      );
    })
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

