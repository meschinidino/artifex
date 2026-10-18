/**
 * Headless connections report for one or more repos:
 *   bun run scripts/connections-report.ts <repo> [<repo>...] [--json <out>]
 *
 * Runs the real pipeline (scan -> parser subprocess -> resolver ->
 * connections extractor -> graph) and prints our totals next to
 * independent grep-style regex totals computed here from raw text,
 * so extractor drift shows as a visible diff, not a silent gap.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { listFiles } from "../watcher/scan.ts";
import { createParserClient, MAX_PARSE_BYTES, languageForPath, type ParseResult } from "../parser/index.ts";
import { buildJvmIndex, buildResolverContext, resolveFileImports } from "../resolver/resolver.ts";
import { extractConnections } from "../connections/extract.ts";
import { buildConnectionGraph, detectServiceName, type RepoInput } from "../connections/graph.ts";
import type { FileConnections } from "../connections/types.ts";

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt !== -1 ? args[jsonAt + 1] : undefined;
const repoPaths = args.filter((a, i) => a !== "--json" && (jsonAt === -1 || i !== jsonAt + 1));
if (repoPaths.length === 0) {
  console.error("usage: bun run scripts/connections-report.ts <repo> [<repo>...] [--json <out>]");
  process.exit(2);
}

function readText(repo: string, path: string): string | undefined {
  try {
    const full = join(repo, path);
    const s = statSync(full);
    if (!s.isFile() || s.size > MAX_PARSE_BYTES) return undefined;
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}

type GrepCounts = {
  files: number; jvmFiles: number; methodMappings: number; classMappings: number;
  tables: Set<string>; feignFiles: number; feignMethods: number;
  kafkaListen: Set<string>; kafkaSend: Set<string>; inRepoImports: number; nativeQueries: number;
};

function grepCounts(repo: string, files: string[]): GrepCounts {
  const g: GrepCounts = {
    files: files.length, jvmFiles: 0, methodMappings: 0, classMappings: 0,
    tables: new Set(), feignFiles: 0, feignMethods: 0,
    kafkaListen: new Set(), kafkaSend: new Set(), inRepoImports: 0, nativeQueries: 0,
  };
  for (const path of files) {
    if (!/\.(java|kt)$/.test(path) || !path.includes("src/main/")) continue;
    const text = readText(repo, path);
    if (!text) continue;
    g.jvmFiles++;
    g.methodMappings += (text.match(/@(Get|Post|Put|Delete|Patch)Mapping/g) ?? []).length;
    g.classMappings += (text.match(/@RequestMapping/g) ?? []).length;
    for (const m of text.matchAll(/@Table\(\s*name\s*=\s*"([^"]+)"/g)) g.tables.add(m[1]!.toLowerCase());
    if (/@FeignClient/.test(text)) {
      g.feignFiles++;
      g.feignMethods += (text.match(/@(Get|Post|Put|Delete|Patch)Mapping/g) ?? []).length;
    }
    for (const m of text.matchAll(/@KafkaListener\(\s*topics\s*=\s*"([^"]+)"/g)) g.kafkaListen.add(m[1]!);
    for (const m of text.matchAll(/kafkaTemplate\.send\(\s*"([^"]+)"/g)) g.kafkaSend.add(m[1]!);
    g.inRepoImports += (text.match(/^import\s+(?:static\s+)?(?!java\.|javax\.|jakarta\.|kotlin\.|org\.springframework|org\.hibernate|lombok|io\.|com\.fasterxml|com\.google|org\.apache)[\w.]+/gm) ?? []).length;
    g.nativeQueries += (text.match(/nativeQuery\s*=\s*true/g) ?? []).length;
  }
  return g;
}

const parser = createParserClient();
const inputs: RepoInput[] = [];
const summaries: unknown[] = [];

for (const repo of repoPaths) {
  const label = basename(repo);
  const files = listFiles(repo);
  const parseables = files.filter((p) => languageForPath(p) !== undefined);
  const results = new Map<string, ParseResult>();
  const connections = new Map<string, FileConnections>();
  const CHUNK = 256;
  for (let i = 0; i < parseables.length; i += CHUNK) {
    const slice = parseables.slice(i, i + CHUNK)
      .map((path) => ({ path, content: readText(repo, path) }))
      .filter((x): x is { path: string; content: string } => x.content !== undefined);
    for (const f of slice) {
      const fc = extractConnections(f.path, f.content);
      if (fc) connections.set(f.path, fc);
    }
    for (const r of await parser.parse(slice)) results.set(r.path, r);
  }
  const fileSet = new Set(files);
  const jvm = buildJvmIndex([...results.values()]);
  const ctx = buildResolverContext(fileSet, (p) => readText(repo, p), jvm);
  const typeIndex = new Map<string, string[]>();
  const addType = (name: string, path: string) => {
    const list = typeIndex.get(name) ?? [];
    if (!list.includes(path)) list.push(path);
    typeIndex.set(name, list);
  };
  for (const r of results.values()) for (const t of r.declaredTypes ?? []) addType(t, r.path);
  for (const [path, fc] of connections) if (fc.className) addType(fc.className, path);
  const importTargets = new Map<string, Set<string>>();
  const importSpecifiers = new Map<string, string[]>();
  let beltCount = 0;
  let unresolvedTotal = 0;
  for (const r of results.values()) {
    if (!r.ok) continue;
    const belts = resolveFileImports(r.path, r.imports, ctx, r);
    importTargets.set(r.path, new Set(belts.targets));
    importSpecifiers.set(r.path, r.imports.flatMap((x) =>
      x.lang === "jvm" ? [x.fqn] : x.lang === "py" ? x.names.map((n) => `${x.module}.${n}`) : [x.specifier],
    ));
    beltCount += belts.targets.length;
    unresolvedTotal += belts.unresolved;
  }
  const serviceName = detectServiceName(files, (p) => readText(repo, p));
  inputs.push({ label, serviceName, files: connections, typeIndex, importTargets, importSpecifiers });
  const parseStates = { ok: 0, error: 0 };
  for (const r of results.values()) (r.ok ? parseStates.ok++ : parseStates.error++);
  summaries.push({ repo: label, serviceName, files: files.length, parseables: parseables.length, parseStates, beltCount, unresolvedTotal, grep: undefined as unknown });
  const g = grepCounts(repo, files);
  (summaries[summaries.length - 1] as { grep: unknown }).grep = {
    ...g, tables: [...g.tables].sort(), kafkaListen: [...g.kafkaListen], kafkaSend: [...g.kafkaSend],
  };
  console.log(`\n== ${label} (service: ${serviceName ?? "?"}) ==`);
  console.log(`files=${files.length} parseable=${parseables.length} parseOk=${parseStates.ok} parseError=${parseStates.error}`);
  console.log(`belts(resolved import edges)=${beltCount} unresolvedImports=${unresolvedTotal}`);
  console.log(`grep: jvmFiles(main)=${g.jvmFiles} methodMappings=${g.methodMappings} classMappings=${g.classMappings} @Table names=${g.tables.size} feignFiles=${g.feignFiles} feignMethods=${g.feignMethods} kafkaListen=[${[...g.kafkaListen]}] kafkaSend=[${[...g.kafkaSend]}] nativeQueries=${g.nativeQueries}`);
}
parser.terminate();

const graph = buildConnectionGraph(inputs);
let endpointsWithTables = 0;
let endpointTotal = 0;
const extractedTables = new Set<string>();
const extractedTopics = new Set<string>();
let feignCalls = 0;
for (const [, summary] of graph.byFile) {
  for (const ep of summary.endpoints) { endpointTotal++; if (ep.tables.length > 0) endpointsWithTables++; }
  for (const t of summary.tables) extractedTables.add(t.table);
  for (const t of summary.topics) extractedTopics.add(t.topic);
  feignCalls += summary.calls.filter((c) => c.via === "feign").length;
}
console.log(`\n== graph (${inputs.length} repo(s)) ==`);
console.log(`endpoints(expanded)=${graph.totals.endpoints} endpointsWithProvenTables=${endpointsWithTables}/${endpointTotal}`);
console.log(`calls=${graph.totals.calls} feignCalls=${feignCalls} matched=${graph.totals.matchedCalls} unmatched=${graph.totals.unmatchedCalls} crossRepoLinks=${graph.totals.crossRepoLinks}`);
console.log(`tables(distinct, reachable)=${graph.totals.tables} topics=${graph.totals.topics} [${[...extractedTopics].sort()}]`);

// Spot samples: first endpoints with tables, first matched cross calls.
console.log("\nsample endpoint -> tables:");
let shown = 0;
for (const [key, s] of graph.byFile) {
  for (const ep of s.endpoints) {
    if (ep.tables.length === 0 || shown >= 8) continue;
    console.log(`  ${key.replace("\0", ":")} ${ep.method} ${ep.path} -> ${ep.handler} :: ${ep.tables.map((t) => `${t.table}(${t.access})`).join(", ")}`);
    shown++;
  }
  if (shown >= 8) break;
}
if (inputs.length > 1) {
  console.log("\nsample matched cross-repo calls:");
  shown = 0;
  for (const [key, s] of graph.byFile) {
    for (const c of s.calls) {
      if (!c.matchedPath || shown >= 8) continue;
      console.log(`  ${key.replace("\0", ":")} ${c.method} ${c.path} -> ${c.matchedPath}`);
      shown++;
    }
    if (shown >= 8) break;
  }
}

if (jsonOut) {
  const payload = {
    repos: summaries,
    totals: graph.totals,
    endpointsWithTables,
    byFile: Object.fromEntries(graph.byFile),
  };
  await Bun.write(jsonOut, JSON.stringify(payload, null, 1));
  console.log(`\njson written: ${jsonOut}`);
}
