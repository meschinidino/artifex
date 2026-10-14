/**
 * Floor store: durable event log (T4). The `.artifex/` directory in the
 * viewed repo now holds floor-state.json (layout, owned by
 * server/index.ts) plus event-log.jsonl (this module): one validated
 * FloorEvent per line, appended as events are emitted, loaded on
 * boot, compacted when overgrown. Same untrusted-repo discipline as
 * the layout persistence: no writes through planted symlinks, no
 * unbounded reads, failures warn and degrade instead of crashing.
 */
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateFloorEvent, type FloorEvent } from "../events/index.ts";

export const STATE_DIR = ".artifex";
export const EVENT_LOG_FILE = "event-log.jsonl";
/** Live log bound, in memory and after compaction. */
export const EVENT_LOG_MAX = 1_000;
/** Line count that triggers a compaction rewrite. */
export const EVENT_LOG_COMPACT_AT = 2 * EVENT_LOG_MAX;
/** Refuse to load a log past this size (same bound as layout state). */
export const MAX_EVENT_LOG_BYTES = 8 * 1024 * 1024;
/**
 * Single events past this stay in memory only: one giant line must
 * never brick the whole-file load (or a compaction) for the rest.
 * Watcher events are ~10^2 bytes; intent ingest must treat an
 * over-cap plan as unpersisted (see TODOS.md, intent binding item).
 */
export const MAX_EVENT_LINE_BYTES = 256 * 1024;

export type EventLogLoad = {
  /** Last `max` valid events, oldest first. */
  events: FloorEvent[];
  /** Total non-empty lines the file held (drives compaction). */
  lines: number;
  /**
   * True when the load was refused (not a regular file, oversize,
   * unreadable). Callers must not mistake this for an empty log —
   * compacting a refused load would destroy the history it holds.
   */
  refused: boolean;
};

function warn(msg: string): void {
  console.error(`warn: ${msg}`);
}

/** Sticky append-failure warn: a dead state dir warns once per outage, not per event. */
let appendWarned = false;
function warnAppendOnce(msg: string): void {
  if (appendWarned) return;
  appendWarned = true;
  warn(msg);
}

/** Raw lines of a state file, or undefined when it must not be read. */
function readStateLines(file: string): string[] | undefined {
  let fileStat;
  try {
    fileStat = lstatSync(file);
  } catch {
    return [];
  }
  try {
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      warn("event log is not a regular file; ignoring");
      return undefined;
    }
    if (fileStat.size > MAX_EVENT_LOG_BYTES) {
      warn(`event log exceeds ${MAX_EVENT_LOG_BYTES} bytes; ignoring`);
      return undefined;
    }
    // Bounded read of the just-checked regular file, mirroring the
    // layout loader: never an unbounded read on an untrusted path.
    const fd = openSync(file, "r");
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_EVENT_LOG_BYTES) {
        warn("event log changed during load; ignoring");
        return undefined;
      }
      const buf = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < opened.size) {
        const n = readSync(fd, buf, offset, opened.size - offset, offset);
        if (n === 0) {
          warn("event log truncated during load; ignoring");
          return undefined;
        }
        offset += n;
      }
      return buf.toString("utf8").split("\n");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    warn(`could not read event log: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function loadEventLog(repo: string, max: number = EVENT_LOG_MAX): EventLogLoad {
  const empty: EventLogLoad = { events: [], lines: 0, refused: false };
  const refused: EventLogLoad = { events: [], lines: 0, refused: true };
  try {
    const dirStat = lstatSync(join(repo, STATE_DIR));
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      warn(".artifex is not a real directory; ignoring event log");
      return refused;
    }
  } catch {
    return empty; // fresh repo: no log yet, not an error
  }
  const raw = readStateLines(join(repo, STATE_DIR, EVENT_LOG_FILE));
  if (raw === undefined) return refused;
  const events: FloorEvent[] = [];
  let skipped = 0;
  let lines = 0;
  for (const line of raw) {
    if (line.length === 0) continue;
    lines++;
    try {
      events.push(validateFloorEvent(JSON.parse(line)));
    } catch {
      // One bad line never wipes valid history around it.
      skipped++;
    }
  }
  if (skipped > 0) warn(`skipped ${skipped} corrupt event-log line(s)`);
  return { events: events.slice(-max), lines, refused: false };
}

/**
 * Append one validated event. Returns false (having warned) when the
 * write was refused or failed — the floor keeps serving either way.
 * Callers keep refused events in memory only; they never reach disk.
 */
export function appendEventLog(repo: string, event: FloorEvent): boolean {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
    warnAppendOnce(`event exceeds ${MAX_EVENT_LINE_BYTES} bytes; keeping in memory only`);
    return false;
  }
  try {
    const dir = join(repo, STATE_DIR);
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        warnAppendOnce(".artifex is a symlink; refusing to write event log");
        return false;
      }
    } catch { /* missing: created below */ }
    mkdirSync(dir, { recursive: true });
    const file = join(dir, EVENT_LOG_FILE);
    try {
      // An append follows symlinks, so a planted log link would
      // redirect writes outside the repo: refuse it explicitly.
      if (lstatSync(file).isSymbolicLink()) {
        warnAppendOnce("event log is a symlink; refusing to write");
        return false;
      }
    } catch { /* missing: created by the append */ }
    appendFileSync(file, line);
    appendWarned = false;
    return true;
  } catch (err) {
    warnAppendOnce(`could not append event log: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Rewrite the log to its newest valid events (at most `max` lines
 * totaling at most half the load bound) via atomic tmp+rename.
 * Returns the line count after compaction. A refused load bails out
 * instead of rewriting: the file on disk stays untouched.
 */
export function compactEventLog(repo: string, max: number = EVENT_LOG_MAX): number {
  const { events, refused } = loadEventLog(repo, max);
  if (refused) {
    warn("event log refused; skipping compaction (history preserved)");
    // Retry after another ~1000 appends, not on every event.
    return EVENT_LOG_MAX;
  }
  // Byte-aware tail: line counts alone cannot bound the file once
  // events vary in size, and an over-bound rewrite would refuse to
  // load next boot. Always keep at least the newest event.
  const budget = MAX_EVENT_LOG_BYTES / 2;
  let bytes = 0;
  let keep = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(events[i]), "utf8") + 1;
    if (keep > 0 && bytes + size > budget) break;
    bytes += size;
    keep++;
  }
  const tail = events.slice(events.length - keep);
  const text = tail.length > 0 ? `${tail.map((e) => JSON.stringify(e)).join("\n")}\n` : "";
  let tmp: string | undefined;
  try {
    const dir = join(repo, STATE_DIR);
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        warn(".artifex is a symlink; refusing to compact event log");
        return tail.length;
      }
    } catch { /* missing: created below */ }
    mkdirSync(dir, { recursive: true });
    // Bytes, not chars: a multibyte tail can pass a char count while
    // exceeding the load bound on disk (defense in depth — the tail
    // budget above already bounds the normal path).
    if (Buffer.byteLength(text, "utf8") > MAX_EVENT_LOG_BYTES) {
      warn(`compacted event log exceeds ${MAX_EVENT_LOG_BYTES} bytes; keeping current file`);
      return tail.length;
    }
    const file = join(dir, EVENT_LOG_FILE);
    tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, file);
    tmp = undefined;
  } catch (err) {
    if (tmp) try { unlinkSync(tmp); } catch { /* already gone */ }
    warn(`could not compact event log: ${err instanceof Error ? err.message : String(err)}`);
  }
  return tail.length;
}
