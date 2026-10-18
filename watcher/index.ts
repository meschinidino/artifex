/**
 * Filesystem watcher (T3a, issue #2): recursive fs.watch with a
 * 100 ms debounce. Raw events are resolved against a known-file map
 * by stat, so create/modify/delete are exact; a delete plus a create
 * sharing device+inode inside one window is a rename. Events are
 * hints, not truth (bursts coalesce: 9 unlinks may arrive as 1
 * event), so a reported delete re-verifies against disk and a
 * periodic backstop rescan catches anything quieter still. Watcher
 * errors and raw-event overflow also fall back to a full rescan.
 */
import { lstatSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { isExcluded, listFiles } from "./scan.ts";

export type FileMeta = { dev: number; ino: number; size: number; mtimeMs: number };

export type WatchChange =
  | { kind: "created"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; path: string; fromPath: string };

export type WatcherHandle = {
  /** Current known-file metadata (kept in sync by the watcher). */
  known: Map<string, FileMeta>;
  close(): void;
};

const DEBOUNCE_MS = 100;
const MAX_WAIT_MS = 1_000;
const OVERFLOW_EVENTS = 5_000;

function statMeta(repo: string, path: string): FileMeta | undefined {
  try {
    const full = join(repo, path);
    // Same containment as the scan/server reads: a symlink escaping
    // the repo never enters the known map, so it can never become a
    // phantom layout entry the server then refuses to build.
    if (lstatSync(full).isSymbolicLink()) {
      const realRepo = realpathSync(repo);
      const real = realpathSync(full);
      if (real !== realRepo && !real.startsWith(realRepo + sep)) return undefined;
    }
    const s = statSync(full);
    if (!s.isFile()) return undefined;
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

export function snapshotMeta(repo: string, paths: readonly string[]): Map<string, FileMeta> {
  const map = new Map<string, FileMeta>();
  for (const path of paths) {
    const meta = statMeta(repo, path);
    if (meta) map.set(path, meta);
  }
  return map;
}

/**
 * Diff a fresh listing against the known map, pairing renames by
 * device+inode. Pure aside from the stat calls it is handed.
 */
export function diffListing(
  known: Map<string, FileMeta>,
  current: Map<string, FileMeta>,
): WatchChange[] {
  const changes: WatchChange[] = [];
  const deleted: string[] = [];
  for (const path of known.keys()) {
    if (!current.has(path)) deleted.push(path);
  }
  const created: string[] = [];
  for (const [path, meta] of current) {
    const before = known.get(path);
    if (!before) created.push(path);
    else if (before.size !== meta.size || before.mtimeMs !== meta.mtimeMs || before.ino !== meta.ino || before.dev !== meta.dev) {
      changes.push({ kind: "modified", path });
    }
  }
  const deletedByInode = new Map<string, string>();
  for (const path of deleted) {
    const meta = known.get(path)!;
    deletedByInode.set(`${meta.dev}:${meta.ino}`, path);
  }
  const renamedFrom = new Set<string>();
  for (const path of created) {
    const meta = current.get(path)!;
    const from = deletedByInode.get(`${meta.dev}:${meta.ino}`);
    // Inode numbers are reused: a delete+create of unrelated files in
    // one window can collide. A real rename preserves size and mtime,
    // so require those too before calling it a rename.
    const fromMeta = from ? known.get(from) : undefined;
    if (from && fromMeta && fromMeta.size === meta.size && fromMeta.mtimeMs === meta.mtimeMs && !renamedFrom.has(from)) {
      renamedFrom.add(from);
      changes.push({ kind: "renamed", path, fromPath: from });
    } else {
      changes.push({ kind: "created", path });
    }
  }
  for (const path of deleted) {
    if (!renamedFrom.has(path)) changes.push({ kind: "deleted", path });
  }
  return changes;
}

export function watchRepo(
  repo: string,
  initialPaths: readonly string[],
  onChanges: (changes: WatchChange[]) => void,
  onState: (state: "watching" | "rescanning") => void,
  opts?: {
    verifyIntervalMs?: number;
    /** Listing override for rescans (multi-repo floors watch a shared parent root). */
    listFiles?: () => string[];
    /** Extra membership filter on top of the hard excludes. */
    includePath?: (path: string) => boolean;
  },
): WatcherHandle {
  const skip = (path: string): boolean => isExcluded(path) || (opts?.includePath !== undefined && !opts.includePath(path));
  const known = snapshotMeta(repo, initialPaths);
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTouchAt: number | undefined;
  let needsRescan = false;
  let restartDelay = 500;
  let touched = new Set<string>();
  let rawCount = 0;
  let closed = false;

  function applyChanges(changes: WatchChange[], current: Map<string, FileMeta>) {
    for (const change of changes) {
      if (change.kind === "deleted") known.delete(change.path);
      else if (change.kind === "renamed") {
        known.delete(change.fromPath);
        const meta = current.get(change.path);
        if (meta) known.set(change.path, meta);
      } else {
        const meta = current.get(change.path);
        if (meta) known.set(change.path, meta);
      }
    }
    if (changes.length > 0) onChanges(changes);
    // A reported membership change may be the lone survivor of a
    // coalesced burst whose other paths never got events: re-verify
    // against disk so silent siblings surface as a catch-up batch
    // instead of ghosts (burst deletes) or missing floors (burst
    // creates). Debounced and converging: at most one verify in
    // flight, and it diffs empty once caught up. Plain modifies
    // skip this (every keystroke would pay a rescan) and rely on
    // their events plus the slow backstop below.
    const membership = changes.some((c) => c.kind !== "modified");
    if (!closed && verifyTimer === undefined && membership) {
      verifyTimer = setTimeout(() => {
        verifyTimer = undefined;
        rescan();
      }, 500);
    }
  }

  function rescan() {
    if (closed) return;
    onState("rescanning");
    try {
      const current = snapshotMeta(repo, opts?.listFiles ? opts.listFiles() : listFiles(repo));
      applyChanges(diffListing(known, current), current);
    } catch (err) {
      console.error(`warn: rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!closed) onState("watching");
    }
  }

  function flush() {
    timer = undefined;
    firstTouchAt = undefined;
    const paths = touched;
    touched = new Set();
    const overflow = rawCount > OVERFLOW_EVENTS;
    rawCount = 0;
    if (closed) return;
    if (overflow || needsRescan) {
      needsRescan = false;
      rescan();
      return;
    }
    // A deleted directory may report only itself — or, on coalescing
    // platforms, only one file deep inside it. Any touched path that
    // no longer exists pulls its known siblings along: climb to the
    // highest gone ancestor and sweep its known descendants into this
    // flush so they resolve as deletions. Ordinary single-file
    // deletes (parent still there) skip the scan; each swept prefix
    // scans once per flush.
    //
    // A deletion also disturbs its directory: a rename-over (victim
    // swapped under a surviving path) may report only the loser's
    // event, leaving the survivor's new content undetected. Known
    // files under a disturbed directory re-enter the flush so the
    // stat diff below reclassifies them (modified, or deleted when
    // now unreadable).
    const swept = new Set<string>();
    const disturbed = new Set<string>();
    for (const path of [...paths]) {
      let topGone: string;
      try {
        statSync(join(repo, path));
        continue; // still exists: not a deletion
      } catch {
        topGone = path;
      }
      disturbed.add(dirname(path));
      let dir = dirname(path);
      while (dir !== "." && dir !== "") {
        try {
          statSync(join(repo, dir));
          break;
        } catch {
          topGone = dir;
          dir = dirname(dir);
        }
      }
      if (topGone === path && known.has(path)) continue;
      const prefix = `${topGone}/`;
      if (swept.has(prefix)) continue;
      swept.add(prefix);
      for (const kp of known.keys()) {
        if (kp.startsWith(prefix)) paths.add(kp);
      }
    }
    if (disturbed.size > 0) {
      for (const kp of known.keys()) {
        if (!paths.has(kp) && disturbed.has(dirname(kp))) paths.add(kp);
      }
    }
    // Burst coalescing drops filenames entirely (10 rapid creates
    // in one directory can arrive as 2 events), so every touched
    // directory is reconciled at the directory level: unknown
    // entries join the flush, and known children absent from the
    // listing join too (the stat diff below classifies both). One
    // O(known) pass per flush, stat calls only for unknown entries.
    {
      const touchedDirs = new Set<string>();
      for (const path of paths) touchedDirs.add(dirname(path));
      const listings = new Map<string, Set<string>>();
      for (const dir of touchedDirs) {
        try {
          listings.set(dir, new Set(readdirSync(join(repo, dir))));
        } catch {
          /* dir itself gone: the sweep above already handled it */
        }
      }
      for (const [dir, onDisk] of listings) {
        for (const name of onDisk) {
          const candidate = dir === "." ? name : `${dir}/${name}`;
          if (!known.has(candidate) && !paths.has(candidate) && !skip(candidate)) paths.add(candidate);
        }
      }
      for (const kp of known.keys()) {
        const dir = dirname(kp);
        const onDisk = listings.get(dir);
        if (onDisk !== undefined && !paths.has(kp) && !onDisk.has(basename(kp))) paths.add(kp);
      }
    }
    // A brand-new directory may arrive without per-file events on
    // some platforms; a rescan diff stays truthful. Existing
    // directories with known descendants report child events all the
    // time and must not turn every flush into a full rescan.
    for (const path of paths) {
      try {
        if (!known.has(path) && statSync(join(repo, path)).isDirectory()) {
          const hasDescendants = path === "."
            ? known.size > 0
            : [...known.keys()].some((kp) => kp.startsWith(`${path}/`));
          if (!hasDescendants) {
            rescan();
            return;
          }
        }
      } catch { /* vanished again: handled below */ }
    }
    // Resolve only the touched paths against the known map.
    const subset = new Map<string, FileMeta>();
    for (const path of paths) {
      const before = known.get(path);
      if (before) subset.set(path, before);
    }
    const current = new Map<string, FileMeta>();
    for (const path of paths) {
      const meta = statMeta(repo, path);
      if (meta) current.set(path, meta);
    }
    // Rename may fire only for the OLD path: scan deleted files'
    // directories for unknown siblings so the diff can pair inodes.
    const deletedDirs = new Set<string>();
    for (const path of subset.keys()) {
      if (!current.has(path)) deletedDirs.add(dirname(path));
    }
    for (const dir of deletedDirs) {
      let entries: string[] = [];
      try {
        entries = readdirSync(join(repo, dir));
      } catch { continue; }
      for (const name of entries) {
        const candidate = dir === "." ? name : `${dir}/${name}`;
        if (known.has(candidate) || current.has(candidate) || skip(candidate)) continue;
        const meta = statMeta(repo, candidate);
        if (meta) current.set(candidate, meta);
      }
    }
    // Rename may fire only for the new path (FSEvents coalescing):
    // pair a created file with a known file sharing its inode when
    // that known path no longer exists on disk.
    const knownByInode = new Map<string, string>();
    for (const [path, meta] of known) knownByInode.set(`${meta.dev}:${meta.ino}`, path);
    for (const [path, meta] of current) {
      if (known.has(path)) continue;
      const old = knownByInode.get(`${meta.dev}:${meta.ino}`);
      if (old && !subset.has(old) && !statMeta(repo, old)) {
        subset.set(old, known.get(old)!);
      }
    }
    applyChanges(diffListing(subset, current), current);
  }

  function schedule() {
    // Debounce with a maximum wait: a continuous write stream must
    // not starve the flush (and its overflow recovery) forever.
    firstTouchAt ??= Date.now();
    if (timer) clearTimeout(timer);
    const waited = Date.now() - firstTouchAt;
    timer = setTimeout(flush, waited >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS);
  }

  function retryStartLater() {
    if (closed) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, 5_000);
    setTimeout(() => {
      if (closed) return;
      start();
      // Events during the restart gap are invisible: reconcile.
      rescan();
    }, delay);
  }

  function start() {
    try {
      watcher = watch(repo, { recursive: true }, (_eventType, filename) => {
        restartDelay = 500;
        if (!filename) {
          // Some platforms omit filenames: only a rescan stays truthful.
          needsRescan = true;
          schedule();
          return;
        }
        const path = filename.toString().split("\\").join("/");
        if (skip(path)) return;
        rawCount++;
        touched.add(path);
        schedule();
      });
      watcher.on("error", (err) => {
        console.error(`warn: watcher error: ${err instanceof Error ? err.message : String(err)}`);
        rescan();
        if (!closed) {
          try { watcher?.close(); } catch { /* already dead */ }
          watcher = undefined;
          retryStartLater();
        }
      });
    } catch (err) {
      // Recursive watch unavailable right now: stay truthful via
      // rescan and keep retrying with backoff instead of going deaf.
      console.error(`warn: recursive watch unavailable: ${err instanceof Error ? err.message : String(err)}`);
      rescan();
      retryStartLater();
    }
  }

  start();

  // Backstop for total event loss (a burst that arrives as zero
  // events schedules no flush at all): reconcile against disk on a
  // slow tick. Silent when clean — diffs, not blind patches.
  const verifyInterval = setInterval(() => {
    if (!closed) rescan();
  }, opts?.verifyIntervalMs ?? 60_000);
  verifyInterval.unref?.();

  return {
    known,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (verifyTimer) clearTimeout(verifyTimer);
      clearInterval(verifyInterval);
      try { watcher?.close(); } catch { /* already closed */ }
    },
  };
}
