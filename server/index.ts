/**
 * Artifex floor server (T3a, issue #2): one Bun process on 127.0.0.1
 * owns floor state, serves the floor UI, and streams snapshot+patch
 * over a token-authenticated WebSocket. The token is injected into
 * the served HTML only — never in URLs or logs.
 */
import { closeSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { EVENTS_VERSION, validateFloorEvent, type FloorEvent } from "../events/index.ts";
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
  type BeltEdge,
  type Building,
  type ClientMessage,
  type ServerMessage,
  type WatcherState,
} from "../floor-ui/wire.ts";
import { createParserClient, languageForPath, MAX_PARSE_BYTES, type ParseResult, type ParserClient } from "../parser/index.ts";
import { parseStateForResult, type ImportRef } from "../parser/protocol.ts";
import { buildResolverContext, resolveFileImports, type FileBelts, type ResolverContext } from "../resolver/resolver.ts";
import { diffListing, snapshotMeta, watchRepo, type WatchChange, type WatcherHandle } from "../watcher/index.ts";
import { decodeUtf8Prefix, isBinaryBuffer, isEnvFile, maskContent } from "../watcher/mask.ts";
import { isExcluded, listFiles } from "../watcher/scan.ts";
import { resolveInsideRepo } from "./paths.ts";
import { appendEventLog, compactEventLog, EVENT_LOG_COMPACT_AT, EVENT_LOG_MAX, loadEventLog } from "./store.ts";

const STATE_DIR = ".artifex";
const STATE_FILE = "floor-state.json";
const PATCH_BATCH_MS = 50;
const CONTENT_CAP = 256 * 1024;

type SocketData = { authed: boolean };

export type FloorServer = {
  port: number;
  token: string;
  url: string;
  eventLog: readonly FloorEvent[];
  buildingCount(): number;
  stop(): void;
};

async function countNewlines(absolute: string): Promise<number> {
  let n = 0;
  let last = -1;
  for await (const chunk of createReadStream(absolute)) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf.length > 0) last = buf[buf.length - 1]!;
  }
  return last === 10 || last === -1 ? n : n + 1;
}

function countBufferLines(buf: Uint8Array): number {
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
function validatePersistedLayout(parsed: unknown): FloorLayout {
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

function loadPersistedLayout(repo: string): { layout?: FloorLayout; reset: boolean } {
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

export async function createFloorServer(opts: {
  repo: string;
  port?: number;
}): Promise<FloorServer> {
  const repo = resolve(opts.repo);
  // Fail fast on a typo'd --repo: without this, the empty listing
  // would boot an empty floor and persistLayout would create the
  // missing directory tree just to write state into it.
  try {
    if (!statSync(repo).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`repo is not a directory: ${repo}`);
  }
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
  // Belt state (T3b, issue #3): raw parser imports per path, their
  // resolution, and the resolver context over the known file set.
  const importsByPath = new Map<string, ImportRef[]>();
  const beltsByPath = new Map<string, FileBelts>();
  const knownFiles = new Set<string>();
  let resolverCtx: ResolverContext = {
    files: new Set(),
    packages: new Map(),
    tsconfigs: new Map(),
    pyRoots: [""],
    isExcluded,
  };
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
      // The read side refuses state over MAX_STATE_BYTES: writing it
      // anyway would reset the layout on every boot and churn .bak
      // forever. Skip the write and keep the last good state.
      const text = JSON.stringify(layout);
      if (text.length > MAX_STATE_BYTES) {
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
    };
  }

  /** Pre-read batch input: null when the pre-pass found nothing readable. */
  type Prebuilt = { meta: FileMeta; result?: ParseResult } | null;

  async function buildBuilding(path: string, pre: Prebuilt | undefined = undefined): Promise<Building | undefined> {
    const meta = pre === undefined ? await readFileMeta(path) : pre?.meta;
    if (!meta) return undefined;
    let result: ParseResult | undefined = pre === undefined || pre === null ? undefined : pre.result;
    if (pre === undefined && meta.text !== undefined) {
      [result] = await parser.parse([{ path, content: meta.text }]);
    }
    if (result !== undefined) {
      // A failed parse keeps the file's last good imports: transient
      // syntax errors dim the lamp without erasing the belts.
      if (result.ok) importsByPath.set(path, result.imports);
    } else {
      importsByPath.delete(path);
    }
    return toBuilding(path, meta, result);
  }

  function isConfigFile(path: string): boolean {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base === "package.json" || base === "tsconfig.json";
  }

  function isInitPy(path: string): boolean {
    return path.slice(path.lastIndexOf("/") + 1) === "__init__.py";
  }

  /**
   * Whether a change alters resolver context: config content always
   * counts, while __init__.py counts on existence flips only (roots
   * do not depend on its content).
   */
  function affectsContext(change: WatchChange): boolean {
    if (change.kind === "renamed") {
      return (
        isConfigFile(change.fromPath) ||
        isConfigFile(change.path) ||
        isInitPy(change.fromPath) ||
        isInitPy(change.path)
      );
    }
    if (isConfigFile(change.path)) return true;
    return isInitPy(change.path) && change.kind !== "modified";
  }

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
    resolverCtx = {
      ...buildResolverContext(knownFiles, (p) => (isConfigFile(p) ? readConfigText(p) : undefined)),
      isExcluded,
    };
  }

  function resolveOne(path: string) {
    const next = resolveFileImports(path, importsByPath.get(path) ?? [], resolverCtx);
    const prev = beltsByPath.get(path);
    beltsByPath.set(path, next);
    if (!prev || prev.unresolved !== next.unresolved || prev.targets.join("\0") !== next.targets.join("\0")) {
      beltsDirty = true;
    }
  }

  function resolveAll() {
    for (const path of buildings.keys()) {
      beltsByPath.set(path, resolveFileImports(path, importsByPath.get(path) ?? [], resolverCtx));
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
  function refreshCounts(before: Map<string, number>, except?: string) {
    for (const [path, b] of buildings) {
      if (path === except) continue;
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
    edges.sort((a, b) =>
      a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0,
    );
    return edges;
  }

  // Zone counts describe rendered buildings, not layout entries: a
  // slot reserved for a currently unreadable file keeps its place
  // (and pad geometry) without inflating the machine count.
  function snapshotZones() {
    const counts = new Map<string, number>();
    for (const b of buildings.values()) counts.set(b.zoneId, (counts.get(b.zoneId) ?? 0) + 1);
    return zoneRects(layout)
      .map((z) => ({ ...z, fileCount: counts.get(z.id) ?? 0 }))
      .filter((z) => z.fileCount > 0);
  }

  function snapshotMessage(): ServerMessage {
    return {
      v: WIRE_VERSION,
      type: "snapshot",
      stateVersion: version,
      repo: basename(repo),
      zones: snapshotZones(),
      buildings: [...buildings.values()],
      belts: currentBelts(),
      total: buildings.size,
      watcher: watcherState,
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
      if (pending.upsert.size === 0 && pending.remove.size === 0 && pending.rename.length === 0 && !pending.force && !beltsDirty) return;
      pending.force = false;
      version += 1;
      const belts = beltsDirty ? currentBelts() : undefined;
      beltsDirty = false;
      broadcast({
        v: WIRE_VERSION,
        type: "patch",
        stateVersion: version,
        upsert: [...pending.upsert.values()],
        remove: [...pending.remove],
        rename: pending.rename,
        ...(belts !== undefined ? { belts } : {}),
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
      removeBuilding(layout, change.path);
      pending.upsert.delete(change.path);
      knownFiles.delete(change.path);
      importsByPath.delete(change.path);
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
      knownFiles.delete(change.fromPath);
      knownFiles.add(change.path);
      // Carry last-good imports to the new path (a failed parse keeps
      // them, like a plain edit); the rebuild below overwrites on ok.
      const carried = importsByPath.get(change.fromPath);
      importsByPath.delete(change.fromPath);
      if (carried !== undefined) importsByPath.set(change.path, carried);
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
      }
      return;
    }
    if (!layout.buildings[change.path]) {
      assignBuilding(layout, change.path, { zoneInitialCount });
    }
    knownFiles.add(change.path);
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
    } else {
      // Keep the layout entry reserved (zone counts come from real
      // buildings, so it cannot inflate them): when the file becomes
      // readable again it returns with the same id and slot instead
      // of drifting to a fresh append slot.
      importsByPath.delete(change.path);
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
  const files = listFiles(repo);
  for (const path of files) knownFiles.add(path);
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
      if (parsed?.ok) importsByPath.set(path, parsed.imports);
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
  );
  if (persisted.reset) {
    console.error("warn: floor state was corrupt or incompatible; layout recomputed (old state kept as .bak)");
  }
  // Reconcile the boot window: files changed between the boot reads
  // and the watcher's baseline snapshot are invisible to a plain
  // known-vs-current diff, so also compare against built buildings.
  enqueue(async () => {
    const current = snapshotMeta(repo, listFiles(repo));
    const handled = new Set<string>();
    const mark = (change: WatchChange) => {
      handled.add(change.path);
      if (change.kind === "renamed") handled.add(change.fromPath);
    };
    const onError = (change: WatchChange, err: unknown) => {
      console.error(`warn: reconcile ${change.kind} ${change.path} failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    // Later groups observe earlier groups' buildings, so each group
    // is its own batch (still one resolveAll per group at most).
    const runGroup = async (changes: WatchChange[]) => {
      for (const change of changes) mark(change);
      await applyBatch(changes, newZoneCounts(changes), onError);
    };
    await runGroup(diffListing(watcher.known, current));
    await runGroup(
      [...buildings.keys()].filter((p) => !current.has(p) && !handled.has(p)).map((path) => ({ kind: "deleted", path }) as WatchChange),
    );
    // Files listed on disk but unbuilt at boot (unreadable then) get
    // one retry here; failures stay out of the baseline below.
    await runGroup(
      [...current.keys()].filter((p) => !buildings.has(p) && !handled.has(p)).map((path) => ({ kind: "created", path }) as WatchChange),
    );
    await runGroup(
      [...current]
        .filter(([path, meta]) => {
          const b = buildings.get(path);
          return !!b && !handled.has(path) && (b.mtimeMs !== meta.mtimeMs || b.bytes !== meta.size);
        })
        .map(([path]) => ({ kind: "modified", path }) as WatchChange),
    );
    // Sync the watcher baseline for the paths this task reconciled.
    // Unbuilt paths stay out of the baseline so a later readable
    // state is re-detected as created; entries this task did not
    // handle are left to the watcher's own fresher updates.
    for (const [path, meta] of current) {
      if (buildings.has(path)) watcher.known.set(path, meta);
      else watcher.known.delete(path);
    }
    for (const path of [...watcher.known.keys()]) {
      if (handled.has(path) && !current.has(path)) watcher.known.delete(path);
    }
    saveLayout();
    schedulePatch();
  });

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
        const unbuilt = Object.keys(layout.buildings).filter((p) => !buildings.has(p)).length;
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
    stop() {
      closed = true;
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
  const repo = flag("--repo") ?? process.cwd();
  const port = Number(flag("--port") ?? "4517");
  createFloorServer({ repo, port })
    .then((floor) => {
      // Flush the pending layout save on Ctrl-C / service stop;
      // stop() only runs if something calls it.
      const shutdown = () => {
        floor.stop();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      console.log(`artifex floor for ${repo} at ${floor.url} (${floor.buildingCount()} buildings)`);
    })
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

