/**
 * T3b import resolver (issue #3): pure mapping from the parser's raw
 * literal import refs to in-repo files. Every ref classifies as
 * resolved (an in-repo edge), external (node_modules, stdlib,
 * site-packages, node: builtins — never a belt), or unresolved
 * (counted per building and in total, never drawn as a guessed edge).
 *
 * Deliberate approximations, all covered by unit tests:
 * - TS bare specifiers resolve through the nearest package.json
 *   self-reference (name/exports/main) and the nearest tsconfig.json
 *   baseUrl/paths (longest-prefix pattern wins). A miss under a
 *   pattern with a literal prefix counts as unresolved (a dangling
 *   alias); an unmatched or catch-all miss falls through to
 *   node_modules (external), like TypeScript. Cross-package monorepo
 *   bare imports are external.
 * - TS `exports` traversal is depth-capped: a hostile nesting depth
 *   resolves as a miss, never a stack overflow.
 * - Python absolute imports search the repo root plus the parent of
 *   each top-level package (a directory holding __init__.py whose
 *   own parent does not). Package directories themselves are NOT
 *   roots: `import sub` must not hit `pkg/sub.py`. Repo-local modules
 *   shadow stdlib names; misses are external (stdlib or
 *   site-packages). Relative misses are unresolved.
 * - tsconfig `extends` chains are not followed.
 */
import { posix } from "node:path";
import type { ImportRef } from "../parser/protocol.ts";

export type PackageInfo = {
  name?: string;
  main?: string;
  exports?: unknown;
};

export type TsconfigInfo = {
  baseUrl?: string;
  paths?: Record<string, string[]>;
};

export type ResolverContext = {
  /** Repo-relative POSIX paths of candidate target files. */
  files: Set<string>;
  /** Keyed by package directory ("" for the repo root). */
  packages: Map<string, PackageInfo>;
  /** Keyed by tsconfig directory ("" for the repo root). */
  tsconfigs: Map<string, TsconfigInfo>;
  /** Python import roots: "" plus the parent of each top-level package. Cached per context so absolute refs never rescan the file set. */
  pyRoots: string[];
  /**
   * Scan-exclusion predicate (wired by the server). A miss under an
   * excluded dir is mapped-but-unshown (external), not a dangling
   * in-repo edge. Absent in unit tests, where nothing is excluded.
   */
  isExcluded?: (path: string) => boolean;
};

export type Resolution =
  | { kind: "resolved"; target: string }
  | { kind: "external" }
  | { kind: "unresolved" };

export type FileBelts = {
  /** Sorted unique in-repo target paths. */
  targets: string[];
  /** Count of refs that looked in-repo but matched nothing. */
  unresolved: number;
};

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Strip // and block comments plus trailing commas, string-aware. */
export function parseJsonc(text: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  const peek = (j: number): string => (j < text.length ? text[j]! : "");
  // Skip whitespace and comments: a trailing comma stays trailing
  // even when a comment sits between it and the closing bracket.
  const skipTrivia = (j: number): number => {
    while (j < text.length) {
      const d = text[j]!;
      if (/\s/.test(d)) {
        j++;
        continue;
      }
      if (d === "/" && text[j + 1] === "/") {
        while (j < text.length && text[j] !== "\n") j++;
        continue;
      }
      if (d === "/" && text[j + 1] === "*") {
        j += 2;
        while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      break;
    }
    return j;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && peek(i + 1) === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && peek(i + 1) === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && peek(i + 1) === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      const j = skipTrivia(i + 1);
      if (peek(j) === "}" || peek(j) === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Build resolver context from a file set. package.json and
 * tsconfig.json files are parsed JSONC-tolerantly; unreadable or
 * invalid ones are skipped (their dependents classify external).
 */
export function buildResolverContext(
  files: Set<string>,
  readFile: (path: string) => string | undefined,
): ResolverContext {
  const packages = new Map<string, PackageInfo>();
  const tsconfigs = new Map<string, TsconfigInfo>();
  for (const path of files) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base !== "package.json" && base !== "tsconfig.json") continue;
    const text = readFile(path);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (base === "package.json") {
      const info: PackageInfo = {};
      if (typeof parsed.name === "string") info.name = parsed.name;
      if (typeof parsed.main === "string") info.main = parsed.main;
      if (parsed.exports !== undefined) info.exports = parsed.exports;
      packages.set(dir, info);
    } else {
      const info: TsconfigInfo = {};
      const opts = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : undefined;
      if (opts) {
        if (typeof opts.baseUrl === "string") info.baseUrl = opts.baseUrl;
        if (isRecord(opts.paths)) {
          const paths: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(opts.paths)) {
            if (typeof k === "string" && Array.isArray(v) && v.every((e) => typeof e === "string")) {
              paths[k] = v as string[];
            }
          }
          info.paths = paths;
        }
      }
      tsconfigs.set(dir, info);
    }
  }
  return { files, packages, tsconfigs, pyRoots: computePyRoots(files) };
}

/**
 * Python import roots: the repo root plus the parent directory of
 * each top-level package. A top-level package is a directory holding
 * __init__.py whose own parent does not. Nested package dirs and
 * plain source dirs are never roots.
 */
function computePyRoots(files: Set<string>): string[] {
  const pkgDirs = new Set<string>();
  for (const path of files) {
    if (path.endsWith("/__init__.py")) pkgDirs.add(dirOf(path));
  }
  const roots = new Set<string>([""]);
  for (const dir of pkgDirs) {
    if (!pkgDirs.has(dirOf(dir))) roots.add(dirOf(dir));
  }
  return [...roots].sort();
}

/** repo-relative join that fails closed on escapes above the root. */
function joinInRepo(dir: string, spec: string): string | undefined {
  const joined = posix.normalize(dir === "" ? spec : `${dir}/${spec}`);
  if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return undefined;
  return joined;
}

/** Exact hit, extension probes, then /index.* probes (file wins). */
function probeTs(candidate: string, files: Set<string>): string | undefined {
  let clean = candidate.endsWith("/") && candidate.length > 1 ? candidate.slice(0, -1) : candidate;
  if (clean === ".") clean = "";
  if (clean !== "" && files.has(clean)) return clean;
  for (const ext of TS_EXTS) {
    if (files.has(clean + ext)) return clean + ext;
  }
  // ESM-style "./x.js" for a sibling x.ts.
  for (const [jsExt, tsExts] of Object.entries(JS_TO_TS)) {
    if (clean.endsWith(jsExt)) {
      const stem = clean.slice(0, -jsExt.length);
      for (const tsExt of tsExts) {
        if (files.has(stem + tsExt)) return stem + tsExt;
      }
    }
  }
  const indexBase = clean === "" ? "index" : `${clean}/index`;
  for (const ext of TS_EXTS) {
    if (files.has(indexBase + ext)) return indexBase + ext;
  }
  return undefined;
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * Real `exports` conditions nest 2-4 deep; past this cap the config
 * is hostile or corrupt, and the lookup fails as a miss instead of
 * overflowing the stack (a RangeError here would abort boot).
 */
const EXPORTS_MAX_DEPTH = 32;

function pickExportTarget(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (depth >= EXPORTS_MAX_DEPTH) return undefined;
  // Array fallbacks take the first element that picks (existence is
  // checked by the caller, so a missing first entry misses rather
  // than falling through to the second).
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickExportTarget(item, depth + 1);
      if (picked !== undefined) return picked;
    }
    return undefined;
  }
  if (isRecord(value)) {
    // Preferred conditions first, then the rest exactly once: without
    // the skip, a {"default": …} chain visits each level twice and a
    // 32-deep config costs 2^32 calls (a synchronous hang).
    for (const key of ["default", "import", "require"]) {
      const picked = pickExportTarget(value[key], depth + 1);
      if (picked !== undefined) return picked;
    }
    for (const [key, v] of Object.entries(value)) {
      if (key === "default" || key === "import" || key === "require") continue;
      const picked = pickExportTarget(v, depth + 1);
      if (picked !== undefined) return picked;
    }
  }
  return undefined;
}

/** Package-relative target for a subpath via the exports field. */
function exportsTarget(exports: unknown, sub: string): string | undefined {
  if (typeof exports === "string") {
    return sub === "" ? exports : undefined;
  }
  if (!isRecord(exports)) return undefined;
  const key = sub === "" ? "." : `./${sub}`;
  if (key in exports) return pickExportTarget(exports[key]);
  // Conditions-only object (no subpath keys) is the "." sugar form.
  if (sub === "" && Object.keys(exports).every((k) => !k.startsWith("."))) {
    return pickExportTarget(exports);
  }
  // Subpath patterns ("./features/*"), longest prefix wins.
  if (sub !== "") {
    let best: { target: unknown; prefix: string; suffix: string } | undefined;
    for (const [pattern, target] of Object.entries(exports)) {
      const star = pattern.indexOf("*");
      if (!pattern.startsWith("./") || star === -1) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
        if (!best || prefix.length > best.prefix.length) best = { target, prefix, suffix };
      }
    }
    if (best !== undefined) {
      if (typeof best.target !== "string") return pickExportTarget(best.target);
      if (!best.target.includes("*")) return best.target;
      const middle = key.slice(best.prefix.length, key.length - best.suffix.length);
      return best.target.replace("*", () => middle);
    }
  }
  return undefined;
}

function stripDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

function resolveBareTs(spec: string, importerDir: string, ctx: ResolverContext): Resolution {
  const segs = spec.split("/");
  const name = spec.startsWith("@") ? segs.slice(0, 2).join("/") : segs[0]!;
  const sub = spec.startsWith("@") ? segs.slice(2).join("/") : segs.slice(1).join("/");
  if (spec.startsWith("@") && segs.length < 2) return { kind: "external" };

  // Nearest package.json self-reference (name/exports/main).
  const pkgDir = nearestDir(ctx.packages, importerDir);
  if (pkgDir !== undefined) {
    const pkg = ctx.packages.get(pkgDir)!;
    if (pkg.name === name) {
      let mapped: string | undefined;
      if (pkg.exports !== undefined) {
        mapped = exportsTarget(pkg.exports, sub);
      } else if (sub === "") {
        mapped = pkg.main ?? "index.js";
      }
      if (mapped !== undefined) {
        const candidate = joinInRepo(pkgDir, stripDotSlash(mapped));
        if (candidate !== undefined) {
          const hit = probeTs(candidate, ctx.files);
          if (hit !== undefined) return { kind: "resolved", target: hit };
        }
        return missFor(candidate, ctx);
      }
      // The specifier names our own package but maps nowhere: an
      // in-repo miss, counted rather than silenced.
      return { kind: "unresolved" };
    }
  }

  // Nearest tsconfig.json baseUrl + paths (JSONC-tolerant parse).
  const tsDir = nearestDir(ctx.tsconfigs, importerDir);
  if (tsDir !== undefined) {
    const ts = ctx.tsconfigs.get(tsDir)!;
    const base = joinInRepo(tsDir, ts.baseUrl ?? ".");
    if (base !== undefined || ts.baseUrl === undefined) {
      const baseDir = base ?? tsDir;
      if (ts.paths) {
        // TypeScript tries the single longest-prefix matching
        // pattern; a miss there falls through to baseUrl, never to
        // a worse pattern (that would draw a belt tsc would not).
        let best: { targets: string[]; middle: string; prefixLen: number } | undefined;
        for (const [pattern, targets] of Object.entries(ts.paths)) {
          const star = pattern.indexOf("*");
          let middle: string | undefined;
          let prefixLen: number;
          if (star === -1) {
            if (pattern !== spec) continue;
            middle = "";
            prefixLen = pattern.length;
          } else if (
            spec.startsWith(pattern.slice(0, star)) &&
            spec.endsWith(pattern.slice(star + 1)) &&
            spec.length >= pattern.length - 1
          ) {
            middle = spec.slice(star, spec.length - (pattern.length - star - 1));
            prefixLen = star;
          } else {
            continue;
          }
          if (!best || prefixLen > best.prefixLen) best = { targets, middle, prefixLen };
        }
        if (best !== undefined) {
          const { targets, middle } = best;
          for (const target of targets) {
            // Replacement-function form: a "$&" in the specifier is a
            // literal path segment, not a match reference.
            const candidate = joinInRepo(baseDir, stripDotSlash(target.replace("*", () => middle)));
            if (candidate === undefined) continue;
            const hit = probeTs(candidate, ctx.files);
            if (hit !== undefined) return { kind: "resolved", target: hit };
          }
          // The best pattern matched but missed: a literal prefix
          // evidences in-repo intent (an alias that dangles), so it
          // counts. A bare catch-all ("*") carries no intent and
          // falls through to baseUrl like an unmatched specifier.
          if (best.prefixLen > 0) return { kind: "unresolved" };
        }
      }
      if (ts.baseUrl !== undefined) {
        const candidate = joinInRepo(baseDir, spec);
        if (candidate !== undefined) {
          const hit = probeTs(candidate, ctx.files);
          if (hit !== undefined) return { kind: "resolved", target: hit };
        }
      }
    }
  }

  // An unmatched specifier that misses baseUrl is a node_modules
  // dependency TypeScript itself would resolve outside the repo:
  // external, not unresolved.
  return { kind: "external" };
}

/** A miss under an excluded dir is mapped-but-unshown (external), not dangling. */
function missFor(candidate: string | undefined, ctx: ResolverContext): { kind: "unresolved" } | { kind: "external" } {
  if (candidate !== undefined && ctx.isExcluded?.(candidate)) return { kind: "external" };
  return { kind: "unresolved" };
}

function nearestDir<T>(map: Map<string, T>, dir: string): string | undefined {
  let current: string | undefined = dir;
  while (current !== undefined) {
    if (map.has(current)) return current;
    if (current === "") break;
    current = dirOf(current);
  }
  return undefined;
}

export function resolveTsSpecifier(spec: string, importer: string, ctx: ResolverContext): Resolution {
  if (spec === "" || spec.startsWith("/")) return { kind: "unresolved" };
  if (spec === "node:" || spec.startsWith("node:")) return { kind: "external" };
  const importerDir = dirOf(importer);
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    const candidate = joinInRepo(importerDir, spec);
    if (candidate === undefined) return { kind: "unresolved" };
    const hit = probeTs(candidate, ctx.files);
    if (hit !== undefined) return { kind: "resolved", target: hit };
    return missFor(candidate, ctx);
  }
  return resolveBareTs(spec, importerDir, ctx);
}

export type PyRef = Extract<ImportRef, { lang: "py" }>;

function pyCandidates(dotted: string, roots: string[]): string[] {
  const rel = dotted.split(".").join("/");
  const out: string[] = [];
  for (const root of roots) {
    const base = root === "" ? rel : `${root}/${rel}`;
    out.push(`${base}.py`, `${base}/__init__.py`);
  }
  return out;
}

function firstHit(candidates: string[], files: Set<string>): string | undefined {
  for (const c of candidates) {
    if (files.has(c)) return c;
  }
  return undefined;
}

export type PyResolution = {
  targets: string[];
  unresolved: number;
  external: boolean;
};

/**
 * One Python ref may yield several edges (`from . import a, b`).
 * Absolute misses (non-stdlib, not in repo) are site-packages and
 * therefore external; relative misses are unresolved.
 */
export function resolvePyRef(ref: PyRef, importer: string, ctx: ResolverContext): PyResolution {
  const parts = ref.module === "" ? [] : ref.module.split(".");
  if (ref.level === 0) {
    // Repo-local modules shadow stdlib names (the script directory
    // precedes the stdlib on sys.path): look up first, classify the
    // miss after. A miss is stdlib or site-packages — external
    // either way, so no name list is needed.
    const hit = ref.module === "" ? undefined : firstHit(pyCandidates(ref.module, ctx.pyRoots), ctx.files);
    if (hit === undefined) return { targets: [], unresolved: 0, external: true };
    const targets = [hit];
    // `from pkg import sub`: a name that is itself a submodule is an
    // edge too, but only on a real file hit (attributes are not files).
    if (hit.endsWith("/__init__.py")) {
      const modDir = hit.slice(0, -"/__init__.py".length);
      for (const name of ref.names) {
        if (name.includes(".")) continue;
        const sub = firstHit([`${modDir}/${name}.py`, `${modDir}/${name}/__init__.py`], ctx.files);
        if (sub !== undefined) targets.push(sub);
      }
    }
    return { targets, unresolved: 0, external: false };
  }

  const anchor = dirOf(importer).split("/").filter((p) => p !== "");
  const up = ref.level - 1;
  if (up > anchor.length) return { targets: [], unresolved: 1, external: false };
  const base = anchor.slice(0, anchor.length - up);
  const prefix = base.length > 0 ? `${base.join("/")}/` : "";
  if (parts.length > 0) {
    // Segments, not dots: joining base with "." and re-splitting
    // would break a directory literally named "foo.bar".
    const rel = [...base, ...parts].join("/");
    const hit = firstHit([`${rel}.py`, `${rel}/__init__.py`], ctx.files);
    if (hit === undefined) return { targets: [], unresolved: 1, external: false };
    const targets = [hit];
    if (hit.endsWith("/__init__.py")) {
      const modDir = hit.slice(0, -"/__init__.py".length);
      for (const name of ref.names) {
        if (name.includes(".")) continue;
        const sub = firstHit([`${modDir}/${name}.py`, `${modDir}/${name}/__init__.py`], ctx.files);
        if (sub !== undefined) targets.push(sub);
      }
    }
    return { targets, unresolved: 0, external: false };
  }
  // `from . import a, b`: every name is a submodule candidate.
  const targets: string[] = [];
  let unresolved = 0;
  for (const name of ref.names) {
    if (name.includes(".")) {
      unresolved++;
      continue;
    }
    const sub = firstHit([`${prefix}${name}.py`, `${prefix}${name}/__init__.py`], ctx.files);
    if (sub !== undefined) targets.push(sub);
    else unresolved++;
  }
  return { targets, unresolved, external: false };
}

/**
 * Resolve one file's raw refs to belt targets plus an unresolved
 * count. Identical refs dedupe (one belt per file pair); targets
 * sort for deterministic snapshots.
 */
export function resolveFileImports(importer: string, imports: ImportRef[], ctx: ResolverContext): FileBelts {
  const targets = new Set<string>();
  let unresolved = 0;
  const seen = new Set<string>();
  for (const ref of imports) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.lang === "ts") {
      const r = resolveTsSpecifier(ref.specifier, importer, ctx);
      if (r.kind === "resolved") targets.add(r.target);
      else if (r.kind === "unresolved") unresolved++;
    } else {
      const r = resolvePyRef(ref, importer, ctx);
      if (r.external) continue;
      for (const t of r.targets) targets.add(t);
      unresolved += r.unresolved;
    }
  }
  targets.delete(importer);
  return { targets: [...targets].sort(), unresolved };
}
