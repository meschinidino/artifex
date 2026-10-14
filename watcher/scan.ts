/**
 * Repo file listing (T3a, issue #2): git ls-files when a .git dir
 * exists (tracked files included even if ignore-matched), else a
 * filesystem walk. Excludes are hard rules in both paths.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

/** True when any path segment is a hard-excluded directory. */
export function isExcluded(repoRelativePath: string): boolean {
  return repoRelativePath.split("/").some((seg) => EXCLUDED_DIRS.has(seg));
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
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
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
