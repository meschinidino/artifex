/**
 * Repo file listing (T3a, issue #2): git ls-files when a .git dir
 * exists (tracked files included even if ignore-matched), else a
 * filesystem walk. Excludes are hard rules in both paths.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseGoModule } from "../resolver/resolver.ts";

export const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "__pycache__",
  ".artifex",
  ".gstack",
]);

/** Build-output directory names: only outputs outside a source tree. */
const OUTPUT_DIRS = new Set(["dist", "build", "out", "target"]);

/**
 * True when a path is hard-excluded. Output names (dist/build/out/
 * target) count only with no `src` segment before them: inside a
 * source tree they are package names (hexagonal `ports/out` is the
 * standard example), and excluding them silently dropped real
 * sources from the floor. Everything else excludes anywhere.
 */
export function isExcluded(repoRelativePath: string): boolean {
  const segs = repoRelativePath.split("/");
  let inSourceTree = false;
  for (const seg of segs) {
    if (seg === "src") inSourceTree = true;
    if (!EXCLUDED_DIRS.has(seg)) continue;
    if (OUTPUT_DIRS.has(seg) && inSourceTree) continue;
    return true;
  }
  return false;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function listViaGit(repo: string): string[] | undefined {
  // The repo being opened is untrusted input: never let its own git
  // config run helper programs (core.fsmonitor) or write cache state
  // into .git during what must be a read-only listing.
  let proc;
  try {
    proc = Bun.spawnSync(
      ["git", "-c", "core.fsmonitor=", "-c", "core.untrackedCache=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return undefined; // git missing/unspawnable: walk fallback applies
  }
  if (proc.exitCode !== 0) return undefined;
  const out = new TextDecoder().decode(proc.stdout);
  return out.split("\0").filter((p) => p.length > 0);
}

function listViaWalk(repo: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Same rule as isExcluded, applied to the directory's own
        // repo-relative path so `src/.../out` packages are walked.
        if (!isExcluded(toPosix(relative(repo, full)))) walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // File symlinks count (git tracks them); the containment
        // filter in listFiles drops any that escape the repo.
        files.push(toPosix(relative(repo, full)));
      }
    }
  };
  walk(repo);
  return files;
}

/** All tracked files as repo-relative POSIX paths, sorted. */
export function listFiles(repo: string): string[] {
  const listed =
    (existsSync(join(repo, ".git")) ? listViaGit(repo) : undefined) ??
    listViaWalk(repo);
  const seen = new Set<string>();
  const out: string[] = [];
  let realRepo: string | undefined;
  for (const path of listed) {
    if (isExcluded(path) || seen.has(path)) continue;
    // git may list paths deleted from disk but still in the index.
    try {
      const full = join(repo, path);
      if (lstatSync(full).isSymbolicLink()) {
        // Symlinks escaping the repo are never listed (never read).
        realRepo ??= realpathSync(repo);
        const real = realpathSync(full);
        if (real !== realRepo && !real.startsWith(realRepo + sep)) continue;
        if (!statSync(real).isFile()) continue;
      } else if (!statSync(full).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out.sort();
}

/** Largest go.mod read while hunting the enclosing module (same cap as server config reads). */
const GO_MOD_MAX = 256 * 1024;

/**
 * Nearest enclosing Go module above `root`. The root itself is the
 * resolver's in-tree job and is never consulted here — the walk
 * starts at the parent. The nearest go.mod decides: a missing
 * module line, an unreadable or oversize file ends the search with
 * no module rather than a farther one (never misattribute outward).
 */
export function findEnclosingGoModule(root: string): { module: string; prefix: string } | undefined {
  let dir = dirname(root);
  for (;;) {
    const candidate = join(dir, "go.mod");
    let st;
    try {
      st = statSync(candidate);
    } catch {
      st = undefined;
    }
    if (st?.isFile()) {
      if (st.size > GO_MOD_MAX) return undefined;
      let text: string;
      try {
        text = readFileSync(candidate, "utf8");
      } catch {
        return undefined;
      }
      const module = parseGoModule(text);
      if (!module) return undefined;
      return { module, prefix: toPosix(relative(dir, root)) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
