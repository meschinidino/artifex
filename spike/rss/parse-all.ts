/**
 * D14 baseline: Bun + web-tree-sitter WASM (TypeScript + Python grammars)
 * parsing the 1000-file corpus. Reports RSS after init and after parsing.
 *
 * Run under /usr/bin/time -l for peak RSS: see spike/rss/README in RESULTS.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Parser from "web-tree-sitter";

const rss = () => (process.memoryUsage().rss / 1048576).toFixed(1);
const root = process.env.ARTIFEX_CORPUS_DIR ?? "/tmp/artifex-spike/corpus1000";
if (!existsSync(root)) {
  console.error(`error: corpus not found at ${root}; run bun run spike/rss/gen-corpus.ts first`);
  process.exit(1);
}

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|py)$/.test(name)) files.push(full);
  }
};
try {
walk(root);

await Parser.init();
console.log(`despues de Parser.init: rss_mb=${rss()}`);
const tsLang = await Parser.Language.load(
  Bun.resolveSync("tree-sitter-wasms/out/tree-sitter-typescript.wasm", import.meta.dir),
);
const pyLang = await Parser.Language.load(
  Bun.resolveSync("tree-sitter-wasms/out/tree-sitter-python.wasm", import.meta.dir),
);
console.log(`gramaticas cargadas (ts+py): rss_mb=${rss()}`);

const t0 = Date.now();
let nodes = 0;
const parser = new Parser();
for (const f of files) {
  parser.setLanguage(f.endsWith(".py") ? pyLang : tsLang);
  const tree = parser.parse(readFileSync(f, "utf8"));
  if (tree) {
    nodes += tree.rootNode.descendantCount;
    tree.delete();
  }
}
console.log(
  `parseados ${files.length} archivos, ${nodes} nodos, en ${Date.now() - t0} ms: rss_mb=${rss()}`,
);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
