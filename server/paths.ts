/**
 * Path security for client-supplied repo paths (T3a, issue #2):
 * repo-relative POSIX only, realpath must stay under the repo root
 * (symlink escapes rejected).
 */
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type PathError = "bad-path" | "not-found";

/** Shape check only: repo-relative POSIX, no escapes or dot segments. */
export function isRepoRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  return !path.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

/**
 * Resolve a client path to an absolute filesystem path inside the
 * repo, following symlinks. Returns a PathError code on rejection.
 */
export function resolveInsideRepo(
  repo: string,
  path: unknown,
): { ok: true; absolute: string } | { ok: false; code: PathError } {
  if (!isRepoRelativePath(path)) return { ok: false, code: "bad-path" };
  let realRepo: string;
  try {
    realRepo = realpathSync(repo);
  } catch {
    return { ok: false, code: "not-found" };
  }
  let real: string;
  try {
    real = realpathSync(join(realRepo, path));
  } catch {
    return { ok: false, code: "not-found" };
  }
  const root = resolve(realRepo);
  if (real !== root && !real.startsWith(root + sep)) {
    return { ok: false, code: "bad-path" };
  }
  return { ok: true, absolute: real };
}
