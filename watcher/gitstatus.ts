/**
 * Git working-tree status (footprint overlays): async
 * `git status --porcelain=v1 -z` per repo root plus a pure
 * porcelain parser. The floor never waits for git: every failure
 * mode (timeout, non-zero exit, unspawnable binary, unparsable
 * entry) degrades to unavailable/untreated, never to fake clean.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isExcluded } from "./scan.ts";

/** HEAD-relative verdict per path: the XY table collapsed (FR1). */
export type FootVerdict = "added" | "modified" | "removed";

/** Repo-relative POSIX paths to verdicts; unfooted paths are absent. */
export type GitStatusMap = Map<string, FootVerdict>;

/**
 * Status argv: the opened repo is untrusted input, so the scan.ts
 * config hardening rides along (no fsmonitor helpers, no cache
 * writes), and the read stays read-only (no gc, no helpers).
 * relativePaths=false pins work-tree-relative output no matter
 * what the viewer's gitconfig sets (subdir roots strip a prefix
 * off exactly this form).
 */
export const GIT_STATUS_ARGV = [
  "git",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "status.relativePaths=false",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=normal",
] as const;

/**
 * Local filter-driver probe: `git status` re-hashes files whose stat
 * info changed, and hashing runs the repo-local `filter.<name>.clean`
 * driver named by `.gitattributes` — a merely-viewed repo could
 * execute code through a planted driver. Any local `filter.*`
 * config (the repo-controlled scope; user/global config is the
 * viewer's own) makes status unavailable instead. Exit 1 with no
 * output is the clean answer (no match); exit 0 means drivers exist.
 */
export const GIT_FILTER_PROBE_ARGV = ["git", "config", "--local", "--get-regexp", "^filter\\."] as const;

/** Live re-reads may take this long; boot reads are stricter. */
export const STATUS_TIMEOUT_LIVE_MS = 10_000;
export const STATUS_TIMEOUT_BOOT_MS = 2_000;
/** At most one status run per label per window (NFR2: <=0.5 Hz). */
export const STATUS_DEBOUNCE_MS = 2_000;

/**
 * Resolve the gitdir owning a repo root: `<repo>/.git` as a
 * directory, else the `gitdir:` pointer when `.git` is a file
 * (linked worktrees). Anything else is unresolvable (index/HEAD
 * watches stay off; flush + backstop triggers still apply).
 */
export function resolveGitdir(repoRoot: string): string | undefined {
  const dotGit = join(repoRoot, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return undefined;
  let first = "";
  try {
    first = readFileSync(dotGit, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return undefined;
  }
  const prefix = "gitdir: ";
  if (!first.startsWith(prefix)) return undefined;
  const target = first.slice(prefix.length).trim();
  if (target.length === 0) return undefined;
  const resolved = target.startsWith("/") ? target : join(dirname(dotGit), target);
  try {
    if (!statSync(resolved).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

/** A label root's enclosing work tree: toplevel dir, POSIX root-relative prefix, gitdir. */
export type WorkTree = { toplevel: string; prefix: string; gitdir: string };

/**
 * Nearest enclosing git work tree at or above `root` (each level
 * via resolveGitdir, so linked worktrees resolve too). `prefix`
 * is "" when the root is the toplevel itself. Undefined outside
 * any work tree — those labels are never queried.
 */
export function findWorkTree(root: string): WorkTree | undefined {
  let dir = root;
  for (;;) {
    const gitdir = resolveGitdir(dir);
    if (gitdir !== undefined) {
      const prefix = dir === root ? "" : relative(dir, root).split(sep).join("/");
      return { toplevel: dir, prefix, gitdir };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type PorcelainOpts = {
  /** Disk-existence probe, consulted for unmerged entries only. */
  exists(path: string): boolean;
  /**
   * Floor members (repo-relative): collapsed untracked-dir entries
   * (`path/`) expand to every member under the prefix. Without it
   * a collapsed entry stamps nothing (never guessed).
   */
  members?: ReadonlySet<string>;
  /**
   * Work-tree-relative prefix of a subdir-served root ("" at the
   * toplevel): status paths strip it, out-of-scope records drop,
   * and a collapsed dir at/above it expands to every member.
   */
  prefix?: string;
};

const isRename = (x: string, y: string): boolean => x === "R" || x === "C" || y === "R" || y === "C";
const isUnmerged = (x: string, y: string): boolean =>
  x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
const isModifiedCode = (x: string, y: string): boolean =>
  x === "M" || x === "T" || y === "M" || y === "T";

/**
 * Map one XY pair to a verdict (FR1 table). `pathExists` is
 * consulted for unmerged entries only (modified when the file
 * exists on disk, removed when it does not); every other code
 * decides without touching disk.
 */
export function verdictForXY(x: string, y: string, pathExists: boolean): FootVerdict | "none" {
  if (x === "?" && y === "?") return "added";
  // Unmerged before the A/D prefix rules: AA is a conflict, not a
  // staged new file, and DD is a conflict, not a plain delete.
  if (isUnmerged(x, y)) return pathExists ? "modified" : "removed";
  if (x === "A") return y === "D" ? "none" : "added"; // AD is net zero vs HEAD
  if (y === "D" || x === "D") return "removed";
  if (isRename(x, y)) return "modified";
  if (isModifiedCode(x, y)) return "modified";
  return "none"; // `!!` and unknown codes fail closed
}

/**
 * Parse `git status --porcelain=v1 -z` bytes (FR1). Records split
 * on NUL; rename entries consume the following bare old-path field
 * (new path gets the verdict, the old path gets nothing); collapsed
 * untracked dirs (`path/`) expand against `members`. `-z` output is
 * raw bytes, so no C-quoting is ever unescaped. Malformed records
 * are skipped, never thrown on (status output is untrusted input).
 * With `opts.prefix` (subdir-served root), work-tree-relative
 * paths strip the prefix and out-of-scope records drop — except a
 * collapsed dir at/above the prefix, which means the whole label
 * root is untracked and expands to every member.
 */
export function parsePorcelainZ(data: Uint8Array, opts: PorcelainOpts): GitStatusMap {
  const out: GitStatusMap = new Map();
  const prefix = opts.prefix ?? "";
  /** Relativize a work-tree-relative file path, or drop it. */
  const inScope = (p: string): string | undefined => {
    if (prefix === "") return p;
    return p.startsWith(prefix + "/") ? p.slice(prefix.length + 1) : undefined;
  };
  const text = new TextDecoder().decode(data);
  const records = text.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") continue; // malformed: fail closed
    const x = record[0]!;
    const y = record[1]!;
    const path = record.slice(3);
    if (isRename(x, y)) {
      // The old path rides as the next bare NUL field: consume it so
      // it never parses as a status record of its own.
      i++;
      const rel = inScope(path);
      if (rel !== undefined && rel.length > 0 && !rel.endsWith("/")) out.set(rel, "modified");
      continue;
    }
    if (path.length === 0) continue;
    if (path.endsWith("/")) {
      // Collapsed untracked dir: stamp every listed path under it.
      if (x === "?" && y === "?" && opts.members) {
        if (prefix !== "" && (prefix + "/").startsWith(path)) {
          // The label root itself — or an ancestor dir above it —
          // is untracked, so the whole root is new.
          for (const member of opts.members) out.set(member, "added");
        } else {
          const rel = inScope(path.slice(0, -1));
          if (rel !== undefined) {
            for (const member of opts.members) {
              if (member.startsWith(rel + "/")) out.set(member, "added");
            }
          }
        }
      }
      continue;
    }
    const rel = inScope(path);
    if (rel === undefined) continue;
    // The disk probe fires for unmerged entries only: a status read
    // must not stat the whole tree to classify plain codes.
    const verdict = verdictForXY(x, y, isUnmerged(x, y) ? opts.exists(rel) : false);
    if (verdict !== "none") out.set(rel, verdict);
  }
  return out;
}

/**
 * Run argv in cwd, capturing stdout bytes. Timeout, non-zero exit,
 * spawn failure, and stderr overflow all resolve undefined (never
 * throw, never hang past the deadline): the caller treats that as
 * status unavailable. Exported for direct timeout/exit testing
 * (a real `git status` is too fast to time out deterministically).
 */
export async function spawnCapture(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<Uint8Array | undefined> {
  let proc;
  try {
    proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  } catch {
    return undefined;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Already dead: the await below reports the real outcome.
    }
  }, Math.max(0, timeoutMs));
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);
    if (timedOut || exitCode !== 0) return undefined;
    return new Uint8Array(stdout);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export type ReadStatusOpts = {
  timeoutMs?: number;
  exists?: (path: string) => boolean;
  members?: ReadonlySet<string>;
};

/**
 * True when the repo's local config names any `filter.*` driver.
 * A probe failure (git missing, not a repo) reads as no drivers —
 * the status run itself will fail the same way and resolve
 * unavailable, so the probe never invents a new failure mode.
 */
export async function hasLocalFilterConfig(repoRoot: string, timeoutMs: number): Promise<boolean> {
  const out = await spawnCapture(GIT_FILTER_PROBE_ARGV, repoRoot, timeoutMs);
  return out !== undefined && out.length > 0;
}

/**
 * Read one label's working-tree status. Resolves a verdict map, or
 * undefined when git is unavailable, too slow, or failing, or when
 * the repo configures local filter drivers (retried on the next
 * trigger, never cached as clean). Hard-excluded paths can never
 * carry a verdict, even when git reports them. Subdir roots strip
 * their work-tree prefix; records outside the root drop.
 */
export async function readGitStatus(repoRoot: string, opts?: ReadStatusOpts): Promise<GitStatusMap | undefined> {
  const timeoutMs = opts?.timeoutMs ?? STATUS_TIMEOUT_LIVE_MS;
  if (await hasLocalFilterConfig(repoRoot, timeoutMs)) return undefined;
  const out = await spawnCapture(GIT_STATUS_ARGV, repoRoot, timeoutMs);
  if (!out) return undefined;
  const prefix = findWorkTree(repoRoot)?.prefix ?? "";
  const exists = opts?.exists ?? ((p: string) => existsSync(join(repoRoot, p)));
  const parsed = parsePorcelainZ(out, { exists, prefix, ...(opts?.members ? { members: opts.members } : {}) });
  for (const path of [...parsed.keys()]) {
    if (isExcluded(path)) parsed.delete(path);
  }
  return parsed;
}
