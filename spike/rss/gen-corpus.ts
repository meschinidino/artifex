/**
 * Generate a deterministic fixture repo for RSS baselines (D14) and
 * T3a acceptance (900-file disk-match, 1,010-file cap/perf).
 *
 * Usage: bun run spike/rss/gen-corpus.ts [--count 1010] [--out DIR] [--folders 50]
 * Defaults preserve the original spike corpus: 1,010 files across
 * 40 TS packages + 10 Python packages in /tmp/artifex-spike/corpus1000.
 * T3a fixtures pass --folders 10.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  // A present-but-empty flag is a caller bug, not a default: failing
  // silently into the default output dir would write (or wipe, via
  // the guard below) somewhere the caller never named.
  const value = args[i + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    console.error(`error: ${name} needs a value`);
    process.exit(1);
  }
  return value;
};
const total = Number(flag("--count", "1010"));
const root = flag("--out", "/tmp/artifex-spike/corpus1000");
const folderCount = Number(flag("--folders", "50"));
if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(folderCount) || folderCount <= 0) {
  console.error("error: --count and --folders must be positive integers");
  process.exit(1);
}

const pyFolders = Math.max(1, Math.round(folderCount * 0.2));
const tsFolders = folderCount - pyFolders;
if (total <= pyFolders) {
  console.error(`error: --count ${total} must exceed the ${pyFolders} python __init__ files`);
  process.exit(1);
}

// Delete guard: this generator wipes its output dir before writing.
// Refuse the OS temp dir itself outright, and refuse any existing
// non-empty target — wherever it lives — unless its contents clearly
// are only a previously generated corpus. Being merely somewhere
// under tmp is not evidence the contents are disposable.
const resolvedRoot = resolve(root);
const tmp = tmpdir();
if (resolvedRoot === tmp) {
  console.error(`error: refusing to delete ${resolvedRoot}: that is the OS temp directory itself`);
  process.exit(1);
}
let existing: string[] = [];
try {
  const target = lstatSync(resolvedRoot);
  if (target.isSymbolicLink() || !target.isDirectory()) {
    console.error(`error: refusing to delete ${resolvedRoot}: not a real directory`);
    process.exit(1);
  }
  existing = readdirSync(resolvedRoot);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error(`error: refusing to delete ${resolvedRoot}: cannot inspect target (${(err as Error).message})`);
    process.exit(1);
  }
}
// Names alone are not proof: a real monorepo can hold only pkgN
// directories. Re-deletion requires the sibling marker this
// generator writes on success (a sibling, so fixture file counts
// inside the corpus stay exact).
const markerPath = `${resolvedRoot}.artifex-gen-corpus`;
let hasMarker = false;
try { hasMarker = lstatSync(markerPath).isFile(); } catch { hasMarker = false; }
const looksGenerated = hasMarker && existing.every((e) => /^(pkg|pypkg)\d+$/.test(e));
if (existing.length > 0 && !looksGenerated) {
  // Pre-marker corpora trip this too: say what is missing so the fix
  // (manual delete) is obvious.
  const hint = hasMarker ? "" : ` (no sibling marker found; delete ${resolvedRoot} manually if it is really a corpus)`;
  console.error(`error: refusing to delete ${resolvedRoot}: does not look like a generated corpus${hint}`);
  process.exit(1);
}

rmSync(resolvedRoot, { recursive: true, force: true });
mkdirSync(resolvedRoot, { recursive: true });
// Python folders also get an __init__.py, counted in the total.
const moduleTotal = total - pyFolders;
const per = Math.floor(moduleTotal / folderCount);
const extra = moduleTotal % folderCount;
const countFor = (folderIndex: number) => per + (folderIndex < extra ? 1 : 0);

let written = 0;
for (let d = 0; d < tsFolders; d++) {
  const dir = join(root, `pkg${d}`);
  mkdirSync(dir, { recursive: true });
  const n = countFor(d);
  for (let f = 0; f < n; f++) {
    const prev = f > 0 ? `import { fn${f - 1} } from "./mod${f - 1}";\n` : "";
    let body = `${prev}export function fn${f}(x: number): number {\n  return x + ${f};\n}\n`;
    for (let k = 0; k < 12; k++) {
      body += `export const v${f}_${k} = fn${f}(${k}) * 2; // value ${k} in module ${f} of package ${d}\n`;
    }
    writeFileSync(join(dir, `mod${f}.ts`), body);
    written++;
  }
}
for (let d = 0; d < pyFolders; d++) {
  const dir = join(root, `pypkg${d}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "__init__.py"), "");
  written++;
  const n = countFor(tsFolders + d);
  for (let f = 0; f < n; f++) {
    const prev = f > 0 ? `from .mod${f - 1} import fn${f - 1}\n` : "";
    let body = `${prev}def fn${f}(x):\n    return x + ${f}\n\n`;
    for (let k = 0; k < 12; k++) {
      body += `v${f}_${k} = fn${f}(${k}) * 2  # value ${k} in module ${f} of package ${d}\n`;
    }
    writeFileSync(join(dir, `mod${f}.py`), body);
    written++;
  }
}
if (written !== total) {
  console.error(`error: se escribieron ${written}, se pidieron ${total}`);
  process.exit(1);
}
writeFileSync(markerPath, "generated by spike/rss/gen-corpus.ts; safe for that tool to delete\n");
console.log(`corpus listo en ${root}: ${written} archivos en ${folderCount} carpetas`);
