/**
 * Parser core (T3b, issue #3): tree-sitter WASM grammars plus the
 * import queries, shared by the batch subprocess. Grammars and
 * queries load lazily and live for the process lifetime: callers
 * run this in a SHORT-LIVED process per batch, because both the
 * per-node accessors and the per-call query cursor retain a little
 * native memory that never returns in-process (+40/+21 MiB measured
 * on the 1,010-file fixture). Exiting the process is the reclaimer.
 */
import Parser from "web-tree-sitter";
import { languageForPath, type ImportRef, type ParseResult } from "./protocol.ts";

const languages = new Map<string, Parser.Language>();
const queries = new Map<string, Parser.Query>();
let parser: Parser | undefined;
let ready: Promise<void> | undefined;

function wasmPath(name: string): string {
  return Bun.resolveSync(`tree-sitter-wasms/out/${name}`, import.meta.dir);
}

function ensureReady(): Promise<void> {
  ready ??= (async () => {
    await Parser.init();
    parser = new Parser();
  })();
  return ready;
}

/** Grammars load lazily per language: an unused grammar never
 *  instantiates its WASM tables into the process budget. */
async function languageFor(name: string): Promise<Parser.Language> {
  await ensureReady();
  let lang = languages.get(name);
  if (!lang) {
    lang = await Parser.Language.load(wasmPath(`tree-sitter-${name}.wasm`));
    languages.set(name, lang);
  }
  return lang;
}

/**
 * Import queries, compiled once per grammar. Matching runs natively
 * in one pass; the handler then reads only the matched subtrees.
 * The extractor must stay at O(matches), never O(nodes).
 */
const TS_IMPORT_QUERY = [
  "(import_statement source: (string) @spec)",
  "(export_statement source: (string) @spec)",
  "(import_require_clause source: (string) @spec)",
  // Calls narrow in the query (O(imports), not O(calls)): dynamic
  // import() by node type, require() by text predicate. The
  // extractor re-checks both as a backstop for grammar drift.
  "(call_expression function: (import) @fn arguments: (arguments) @args)",
  '(call_expression function: (identifier) @fn arguments: (arguments) @args (#eq? @fn "require"))',
].join("\n");

const PY_IMPORT_QUERY = ["(import_statement) @imp", "(import_from_statement) @from"].join("\n");

function queryFor(langName: string, lang: Parser.Language): Parser.Query {
  let query = queries.get(langName);
  if (!query) {
    query = lang.query(langName === "python" ? PY_IMPORT_QUERY : TS_IMPORT_QUERY);
    queries.set(langName, query);
  }
  return query;
}

function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

/**
 * A string node is literal only when every child is a plain
 * fragment: escapes, interpolations, and concatenations are
 * skipped (never guessed). Empty specifiers resolve to nothing
 * downstream.
 */
function literalStringText(node: Parser.SyntaxNode): string | undefined {
  if (node.type !== "string") return undefined;
  let out = "";
  for (const child of namedChildren(node)) {
    if (child.type !== "string_fragment") return undefined;
    out += child.text;
  }
  return out;
}

function extractTsImports(tree: Parser.Tree, query: Parser.Query): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const match of query.matches(tree.rootNode)) {
    const byName = new Map(match.captures.map((c) => [c.name, c.node]));
    const spec = byName.get("spec");
    if (spec) {
      // Side-effect, named/default, export ... from, import-equals.
      // Sourceless exports never match, contributing nothing.
      const specifier = literalStringText(spec);
      if (specifier !== undefined) imports.push({ lang: "ts", specifier });
      continue;
    }
    const fn = byName.get("fn");
    const args = byName.get("args");
    if (!fn || !args) continue;
    if (!(fn.type === "import" || (fn.type === "identifier" && fn.text === "require"))) continue;
    // Literal single-argument calls only: template strings,
    // concatenations, and multi-argument requires are skipped.
    const argChildren = namedChildren(args);
    if (argChildren.length !== 1) continue;
    const specifier = literalStringText(argChildren[0]!);
    if (specifier !== undefined) imports.push({ lang: "ts", specifier });
  }
  return imports;
}

/** Inner dotted name of an import entry, unwrapping `as` aliases. */
function dottedEntryText(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "dotted_name") return node.text;
  if (node.type === "aliased_import") {
    const inner = node.childForFieldName("name");
    if (inner && inner.type === "dotted_name") return inner.text;
  }
  return undefined;
}

function extractPyImports(tree: Parser.Tree, query: Parser.Query): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const match of query.matches(tree.rootNode)) {
    const byName = new Map(match.captures.map((c) => [c.name, c.node]));
    const imp = byName.get("imp");
    if (imp) {
      // `import a, b as c`: one ref per entry (aliases unwrapped).
      for (const child of namedChildren(imp)) {
        const name = dottedEntryText(child);
        if (name !== undefined) imports.push({ lang: "py", level: 0, module: name, names: [] });
      }
      continue;
    }
    const from = byName.get("from");
    if (!from) continue;
    const moduleNode = from.childForFieldName("module_name");
    if (!moduleNode) continue;
    // The module clause precedes the imported names in source
    // order; match it positionally because the WASM binding does
    // not promise object identity across accessors.
    let seenModule = false;
    const names: string[] = [];
    for (const child of namedChildren(from)) {
      if (
        !seenModule &&
        (child.type === "dotted_name" || child.type === "relative_import") &&
        child.type === moduleNode.type &&
        child.text === moduleNode.text
      ) {
        seenModule = true;
        continue;
      }
      const name = dottedEntryText(child);
      if (name !== undefined) names.push(name);
    }
    if (!seenModule) continue;
    if (moduleNode.type === "dotted_name") {
      imports.push({ lang: "py", level: 0, module: moduleNode.text, names });
    } else if (moduleNode.type === "relative_import") {
      // Level is the dot count; the dotted suffix may be absent
      // (`from . import sib`, where the names are the submodules).
      let level = 0;
      let module = "";
      for (const child of namedChildren(moduleNode)) {
        if (child.type === "import_prefix") {
          level = child.text.length;
        } else if (child.type === "dotted_name") {
          module = child.text;
        }
      }
      if (level > 0) imports.push({ lang: "py", level, module, names });
    }
  }
  return imports;
}

function firstError(root: Parser.SyntaxNode): string {
  // Iterative with a visit cap: a pathological deeply-nested file
  // must not overflow the stack or walk unboundedly.
  const stack: Parser.SyntaxNode[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 20_000) {
    const node = stack.pop()!;
    visited++;
    if (node.type === "ERROR" || node.isMissing) {
      const { row, column } = node.startPosition;
      return `parse error at line ${row + 1}, column ${column + 1}`;
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child && (child.hasError || child.type === "ERROR" || child.isMissing)) stack.push(child);
    }
  }
  return "parse error";
}

/**
 * Parse one batch. Per-file isolation: one throwing file (grammar
 * load, WASM fault) marks only itself unavailable, never the rest
 * of its batch, and every tree is deleted even on the error path.
 * Files with a parse error yield no imports: a recovered tree is
 * not trustworthy enough to draw belts from.
 */
export async function parseBatch(files: { path: string; content: string }[]): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  for (const file of files) {
    const langName = languageForPath(file.path);
    if (!langName) {
      results.push({ path: file.path, ok: true, parsed: false, imports: [] });
      continue;
    }
    let tree: Parser.Tree | null = null;
    try {
      await ensureReady();
      const lang = await languageFor(langName);
      parser!.setLanguage(lang);
      tree = parser!.parse(file.content);
      if (!tree) {
        results.push({ path: file.path, ok: false, parsed: true, imports: [], error: "parser returned no tree" });
        continue;
      }
      if (tree.rootNode.hasError) {
        results.push({ path: file.path, ok: false, parsed: true, imports: [], error: firstError(tree.rootNode) });
        continue;
      }
      // A query failure fails the file closed (unparsed) via the
      // catch below, never silently empty.
      const query = queryFor(langName, lang);
      const imports = langName === "python" ? extractPyImports(tree, query) : extractTsImports(tree, query);
      results.push({ path: file.path, ok: true, parsed: true, imports });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ path: file.path, ok: false, parsed: false, imports: [], error: `parser unavailable: ${message}` });
    } finally {
      tree?.delete();
    }
  }
  return results;
}
